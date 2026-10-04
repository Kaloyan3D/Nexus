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
