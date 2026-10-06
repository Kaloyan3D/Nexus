'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnIsolated}=require('../scripts/bench/ccv2-lhcb-02/isolation.cjs');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'lhcb02-isolation-')),install=path.join(tmp,'nexus-root');
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
test('real namespace hides host graders reports and foreign proc; workspace is writable and runtime is read-only',async()=>{
 for(const p of ['workspace','reports','state','nexus-root/data','nexus-root/logs','nexus-root/config'])fs.mkdirSync(path.join(tmp,p),{recursive:true});
 fs.writeFileSync(path.join(install,'config/frozen'),'frozen');fs.writeFileSync(path.join(tmp,'reports/hidden'),'hidden');
 const node=fs.realpathSync(process.execPath);
 // The test executable is outside /usr, so bind its parent read-only for this isolated proof.
 const fixtureNode=path.join(install,'node');fs.copyFileSync(node,fixtureNode);fs.chmodSync(fixtureNode,0o755);
 const program=`const fs=require('fs');let denied=false;try{fs.writeFileSync(${JSON.stringify(path.join(install,'config/frozen'))},'altered')}catch{denied=true;}fs.writeFileSync(${JSON.stringify(path.join(tmp,'workspace/result'))},'ok');console.log(JSON.stringify({denied,hidden:fs.existsSync(${JSON.stringify(path.resolve(__dirname,'../benchmarks/ccv2-lhcb-02/grader/grade.cjs'))}),reports:fs.existsSync(${JSON.stringify(path.join(tmp,'reports/hidden'))}),state:fs.existsSync(${JSON.stringify(path.join(tmp,'state'))}),pid:process.pid}));setTimeout(()=>{},50);`;
 const child=spawnIsolated(fixtureNode,['-e',program],{cwd:path.join(install,'data'),env:{PATH:'/usr/bin:/bin',HOME:tmp}});
 let stdout='',stderr='',owned;
 child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 await new Promise((resolve,reject)=>{child.once('error',reject);child.once('spawn',()=>owned=fs.realpathSync('/proc/'+child.pid+'/exe'));child.once('exit',code=>code===0?resolve():reject(Error(stderr)));});
 assert.equal(owned,fixtureNode);assert.deepEqual(JSON.parse(stdout),{denied:true,hidden:false,reports:false,state:false,pid:2});assert.equal(fs.readFileSync(path.join(tmp,'workspace/result'),'utf8'),'ok');assert.equal(fs.readFileSync(path.join(install,'config/frozen'),'utf8'),'frozen');
});

test('new scratch revision supplies one isolated writable directory outside candidate workspace',async()=>{
 const root=path.join(tmp,'scratch-proof'),runtime=path.join(root,'nexus-root');
 for(const p of ['workspace/src','reports','state','nexus-root/data','nexus-root/logs','nexus-root/config'])fs.mkdirSync(path.join(root,p),{recursive:true});
 const fixtureNode=path.join(runtime,'node');fs.copyFileSync(fs.realpathSync(process.execPath),fixtureNode);fs.chmodSync(fixtureNode,0o755);
 const program=`const fs=require('fs');process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);const p=process.env.LHCB_SCRATCH;let created=false,output=null;if(p){fs.writeFileSync(p+'/probe.py','print(42)');created=true;output=require('child_process').execFileSync('/usr/bin/python3',[p+'/probe.py'],{encoding:'utf8'}).trim();}console.log(JSON.stringify({output,supplied:typeof p==='string',outside:p?!p.startsWith(${JSON.stringify(path.join(root,'workspace'))}+'/'):false,created}));`;
 const child=spawnIsolated(fixtureNode,['-e',program],{cwd:path.join(runtime,'data'),env:{PATH:'/usr/bin:/bin',HOME:root}});let stdout='',stderr='';
 child.stderr.on('data',b=>stderr+=b);
 const ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(stderr)));});
 const ready=new Promise((resolve,reject)=>{let spawned=false,printed=false;const done=()=>{if(spawned&&printed)resolve();};child.once('error',reject);child.once('spawn',()=>{spawned=true;done();});child.stdout.on('data',b=>{stdout+=b;if(stdout.includes('\n')){printed=true;done();}});});
 await ready;process.kill(child.pid,'SIGTERM');await ended;
 assert.deepEqual(JSON.parse(stdout),{output:'42',supplied:true,outside:true,created:true});Scratch.reset(root);Scratch.assertEmpty(root);
});

const Scratch=require('../scripts/bench/ccv2-lhcb-02/scratch.cjs');
function scratchRoot(name){const root=path.join(tmp,name);fs.mkdirSync(path.join(root,'workspace/src'),{recursive:true});fs.mkdirSync(path.join(root,'state'));fs.mkdirSync(path.join(root,'nexus-root/data'),{recursive:true});fs.writeFileSync(path.join(root,'workspace/src/source.ts'),'module.exports={ok:true};');return root;}
test('scratch probe executes and deterministic phase reset leaves candidate bytes unchanged',()=>{
 const root=scratchRoot('probe-execution'),before=fs.readFileSync(path.join(root,'workspace/src/source.ts')),probe=Scratch.resolve(root,'probe.py');fs.writeFileSync(probe,'print(42)\n');
 const result=require('node:child_process').spawnSync('/usr/bin/python3',[probe],{encoding:'utf8'});assert.equal(result.status,0);assert.equal(result.stdout,'42\n');
 const receipt=Scratch.reset(root);assert.equal(receipt.fileCount,1);assert.equal(receipt.emptyAfterReset,true);assert.deepEqual(fs.readFileSync(path.join(root,'workspace/src/source.ts')),before);Scratch.assertEmpty(root);
});
test('scratch rejects absolute and traversal paths before any write',()=>{const root=scratchRoot('traversal');for(const rel of ['../workspace/probe.py','a/../../probe','/tmp/probe','a/./probe','a\\..\\probe'])assert.throws(()=>Scratch.resolve(root,rel),/escape/);assert(!fs.existsSync(path.join(root,'workspace/probe.py')));});
test('scratch symlink escape fails without touching its external target',()=>{const root=scratchRoot('link'),target=path.join(root,'workspace/src/source.ts');fs.symlinkSync(target,Scratch.resolve(root,'escape'));assert.throws(()=>Scratch.inventory(root),/unsupported-file/);assert.throws(()=>Scratch.reset(root),/unsupported-file/);assert.equal(fs.readFileSync(target,'utf8'),'module.exports={ok:true};');});
test('scratch hardlinks and candidate aliases cannot enter snapshots',()=>{const root=scratchRoot('hardlink'),target=path.join(root,'workspace/src/source.ts');fs.linkSync(target,Scratch.resolve(root,'alias'));assert.throws(()=>Scratch.inventory(root),/hardlink/);assert.throws(()=>require('../scripts/bench/ccv2-lhcb-02/official-snapshot.cjs').selected(root),/candidate-hardlink/);});
test('scratch artifact symlink in candidate source is rejected before snapshot inventory',()=>{const root=scratchRoot('source-alias'),probe=Scratch.resolve(root,'probe.py');fs.writeFileSync(probe,'print(42)');fs.symlinkSync(probe,path.join(root,'workspace/src/probe.py'));assert.throws(()=>require('../scripts/bench/ccv2-lhcb-02/official-snapshot.cjs').selected(root),/candidate-alias/);});
test('root probe creation, protected mutation and moving scratch outside permitted surfaces remain protocol failures',()=>{
 const {protectedHashes,CalibrationRunner}=require('../scripts/bench/ccv2-lhcb-02/autorunner.cjs');
 for(const kind of ['root-probe','protected-mutation','scratch-move']){const root=scratchRoot(kind);fs.writeFileSync(path.join(root,'workspace/protected'),'fixed');const before=protectedHashes(root);
  if(kind==='root-probe')fs.writeFileSync(path.join(root,'workspace/probe.py'),'print(42)');
  if(kind==='protected-mutation')fs.writeFileSync(path.join(root,'workspace/protected'),'altered');
  if(kind==='scratch-move'){const probe=Scratch.resolve(root,'probe.py');fs.writeFileSync(probe,'print(42)');fs.renameSync(probe,path.join(root,'workspace/probe.py'));}
  const runner=Object.create(CalibrationRunner.prototype);runner.root=root;runner.save=()=>{};assert.throws(()=>runner.finishAcceptance({promptId:'T00',protectedHashes:before}),/evidence-modified/);
 }
});
test('scratch lifecycle removes every previous phase and arm artifact without changing source guard hashes',()=>{const root=scratchRoot('carryover'),guard=require('../scripts/bench/ccv2-lhcb-02/autorunner.cjs').protectedHashes,before=guard(root);for(const arm of ['native','production','forced']){Scratch.reset(root);assert(!fs.existsSync(Scratch.resolve(root,'previous-arm')));fs.writeFileSync(Scratch.resolve(root,'previous-arm'),arm);assert.deepEqual(guard(root),before);Scratch.reset(root);assert.deepEqual(guard(root),before);}Scratch.assertEmpty(root);});
test('scratch directory itself cannot be replaced with a link into persistent source',()=>{const root=scratchRoot('root-alias');fs.symlinkSync(path.join(root,'workspace/src'),path.join(root,'scratch'));assert.throws(()=>Scratch.directory(root),/directory/);});
