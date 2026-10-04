'use strict';
require('../scripts/bench/ccv2-lhcb-02/bootstrap-network.cjs');
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const {S,load}=require('../scripts/bench/ccv2-lhcb-02/infrastructure.cjs');
const B=require('../scripts/bench/ccv2-lhcb-02/controller-bootstrap.cjs');
const tmp=S.fs.mkdtempSync(S.path.join(S.os.tmpdir(),'lhcb02-production-bootstrap-')),root=S.path.join(tmp,'root');
after(()=>{assert.equal(global.lhcbBootstrapNetwork.attempts(),0);S.fs.rmSync(tmp,{recursive:true,force:true});});
let adapter,authority,sessionId;
test('real staged production API owns preparation, with normal SessionStore persistence and no inference',()=>{
 require('../scripts/bench/ccv2-lhcb-02/prepare.cjs').prepare(root);load('init').stageRuntime(root,S.os.homedir()+'/.local/share/nexus');
 adapter=B.createAdapter(root);sessionId='session-'+S.crypto.randomUUID();assert.deepEqual(adapter.create(sessionId),{sessionId});
 const raw=S.path.join(root,'nexus-root/data/routing/session-bindings.json');assert(!S.fs.existsSync(raw));
 authority=adapter.prepare(sessionId);assert.deepEqual(Object.keys(authority).sort(),['sessionId','taskId','taskInstanceId','engine','profile','provider','model'].sort());assert.deepEqual(B.exact(authority,sessionId),authority);
 assert.equal(authority.provider,'opencode-go');assert.equal(authority.model,'muse-spark-1.3-contributor');assert.equal(global.lhcbBootstrapNetwork.attempts(),0);
 const rows=S.read(S.path.join(root,'workspace/.ai-harness/state/tasks.json')).tasks;assert.equal(rows.length,1);assert.equal(rows[0].attempt,0);
 const source=S.fs.readFileSync(S.path.join(S.REPO,'scripts/bench/ccv2-lhcb-02/controller-bootstrap.cjs'),'utf8');
 assert.match(source,/controller\.prepareSession\(ctx,\{sessionId,cwd:workspace,preset:'aih-muse',profileId:target.profile\}\)/);
 assert.doesNotMatch(source,/S\.write|writeFile|appendFile/,'adapter never writes production authority');
 assert(!S.fs.existsSync(S.path.join(root,'state/calibration-journal.json')));
});
test('restarting create/prepare recovers the original instance and independently verifies persisted agreement',()=>{
 const restored=B.createAdapter(root);assert.deepEqual(restored.create(sessionId),{sessionId});assert.deepEqual(restored.prepare(sessionId),authority);assert.deepEqual(restored.verify(authority),authority);
 const tasks=S.read(S.path.join(root,'workspace/.ai-harness/state/tasks.json')).tasks;assert.equal(tasks.length,1);
});
for(const field of ['engine','profile','provider','model'])test('returned '+field+' drift rejects before prompt',()=>assert.throws(()=>B.verify(root,{...authority,[field]:'wrong'}),/authority-invalid/));
function mutate(file,edit,check){const original=S.fs.readFileSync(file);try{const document=JSON.parse(original);edit(document);S.write(file,document);check();}finally{S.fs.writeFileSync(file,original);}}
test('wrong persisted cwd is rejected',()=>mutate(S.path.join(root,'nexus-root/data/routing/session-bindings.json'),x=>x.bindings[sessionId].workspace=tmp,()=>assert.throws(()=>B.verify(root,authority),/binding-mismatch/)));
test('conflicting binding generation is rejected',()=>mutate(S.path.join(root,'nexus-root/data/routing/session-bindings.json'),x=>x.bindings[sessionId].taskInstanceId='foreign',()=>assert.throws(()=>B.verify(root,authority),/binding-mismatch/)));
test('routing target and generation must agree with returned production authority',()=>{
 const install=S.path.join(root,'nexus-root'),binding=S.read(S.path.join(install,'data/routing/session-bindings.json')).bindings[sessionId],file=require(S.path.join(install,'config/Engineering-Profiles.cjs')).routingStatePath(install,binding);
 for(const key of ['provider','model','profile','taskInstanceId'])mutate(file,x=>x[key]='foreign',()=>assert.throws(()=>B.verify(root,authority),/routing-mismatch/));
});
test('ledger identity and zero attempt are independent pre-submission requirements',()=>{
 const file=S.path.join(root,'workspace/.ai-harness/state/tasks.json');for(const key of ['taskInstanceId','attempt'])mutate(file,x=>x.tasks[0][key]=key==='attempt'?1:'foreign',()=>assert.throws(()=>B.verify(root,authority),/ledger-mismatch/));
});
test('production diagnostic must exist with the exact seven-field authority',()=>{
 const file=S.path.join(root,'nexus-root/data/logs/aih-controller.log'),original=S.fs.readFileSync(file);try{S.fs.writeFileSync(file,'');assert.throws(()=>B.verify(root,authority),/diagnostic-missing/);}finally{S.fs.writeFileSync(file,original);}
});
test('blank persisted session retains no prompt, provider or counter events',()=>{
 const artifacts=load('autorunner').AutoRunner.prototype.sessionArtifacts.call({root},sessionId);assert.equal(artifacts.length,1);const session=load('session').decode(root,artifacts[0]);assert.equal(session.header.id,sessionId);assert.equal(session.header.cwd,S.path.join(root,'workspace'));assert(B.blankEvents(session.events));assert.deepEqual(session.events.map(x=>x.type),['agent-preset/selected','session/end-seed']);
});
test('frozen source guard uses e0282c1 and detects bootstrap authority drift',()=>{
 const install=S.path.join(root,'nexus-root'),D=load('doctor');assert.equal(D.sourceGuard(S.REPO,install).baseSha,'e0282c11d5bee29359c277cd5a9568ca13d62885');assert(D.sourceGuard(S.REPO,install).pass);
 const file=S.path.join(install,'config/AihController.cjs'),original=S.fs.readFileSync(file);try{S.fs.appendFileSync(file,'\n// drift');assert(!D.sourceGuard(S.REPO,install).pass);}finally{S.fs.writeFileSync(file,original);}
});
test('historical forensic roots are rejected without modification',()=>{
 for(const suffix of ['20261004','20261004-02'])assert.throws(()=>S.rootOf(S.path.join(tmp,'calibration-morning-'+suffix)),/historical-root/);
});
test('actual worker death during production preparation resumes its original allocation',()=>{
 const id='session-'+S.crypto.randomUUID();adapter.create(id);
 const fault=S.path.join(tmp,'kill-before-binding.cjs');S.fs.writeFileSync(fault,"const fs=require('node:fs'),rename=fs.renameSync;fs.renameSync=(a,b)=>{if(String(b).endsWith('/routing/session-bindings.json'))process.exit(77);return rename(a,b);};");
 const node=S.path.join(root,'nexus-root/runtime/node/bin/node'),worker=S.path.join(S.REPO,'scripts/bench/ccv2-lhcb-02/controller-bootstrap.cjs');
 const result=require('node:child_process').spawnSync(node,['--require',S.path.join(S.REPO,'scripts/bench/ccv2-lhcb-02/bootstrap-network.cjs'),'--require',fault,worker,root,id,'prepare'],{encoding:'utf8',env:{...process.env,NODE_OPTIONS:''}});assert.equal(result.status,77,result.stderr);
 const ledger=S.path.join(root,'workspace/.ai-harness/state/tasks.json'),before=S.read(ledger).tasks;assert.equal(before.length,2);
 const recovered=adapter.prepare(id);assert.equal(recovered.taskInstanceId,before[1].taskInstanceId);assert.equal(S.read(ledger).tasks.length,2);assert.equal(S.read(ledger).tasks[1].attempt,0);
});
