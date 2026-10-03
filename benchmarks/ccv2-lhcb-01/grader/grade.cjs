'use strict';
const S=require('../../../scripts/bench/ccv2-lhcb/state.cjs');
const {spawnSync}=require('node:child_process');
const obligations=require('../obligations.json');
const fixture=require('../fixture/create-fixture.cjs');
function grade(workspace) {
  S.noLinks(workspace);
  const env={PATH:process.env.PATH,NODE_OPTIONS:'--require='+S.path.join(__dirname,'offline.cjs'),LANG:'C',TZ:'UTC'};
  const hidden=spawnSync(process.execPath,[S.path.join(__dirname,'cases.cjs'),workspace],{env,encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024});
  let results;try{if(hidden.status!==0)throw Error();results=JSON.parse(hidden.stdout);if(results.length!==20||results.some((x,i)=>x.id!==obligations[i].id||typeof x.passed!=='boolean'))throw Error();}catch{results=obligations.map(o=>({id:o.id,passed:false,evidence:'Hidden check process failed or timed out'}));}
  let names=[];try{names=S.fs.readdirSync(S.path.join(workspace,'test'));}catch{}
  const testFiles=names.filter(x=>x.endsWith('.test.cjs')).sort().map(x=>S.path.join(workspace,'test',x));
  const tests=testFiles.length?spawnSync(process.execPath,['--test',...testFiles],{cwd:workspace,env,encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024}):{status:1};
  let unchanged=false;try{unchanged=S.hash(S.fs.readFileSync(S.path.join(workspace,'test/regression.test.cjs')))===S.hash(fixture.files['test/regression.test.cjs']);}catch{}
  const finalTestsPass=tests.status===0&&unchanged;
  results[19].passed=results[19].passed&&finalTestsPass;results[19].evidence=results[19].passed?'Regression suite unchanged and all tests pass':'Regression or existing-record preservation failed';
  const critical=results.filter((x,i)=>obligations[i].critical);
  const passed=results.filter(x=>x.passed).length;
  return {taskSuccess:finalTestsPass&&critical.every(x=>x.passed)&&passed>=19,finalTestsPass,critical:{passed:critical.filter(x=>x.passed).length,total:critical.length},obligations:{passed,total:20,results},execution:{hiddenExit:hidden.status,testsExit:tests.status,networkPolicy:'Node network APIs blocked; child environment contains no credentials'}};
}
module.exports={grade};
if(require.main===module)try{console.log(S.json(grade(S.path.resolve(process.argv[2]))));}catch{console.error('lhcb-grade-failed');process.exitCode=1;}
