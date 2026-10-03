#!/usr/bin/env node
'use strict';
const {S,load}=require('./infrastructure.cjs');
async function main(args){
  if(process.version!=='v24.18.1')S.fail('lhcb02-node-version');
  if(args.length!==2)S.fail('lhcb02-command-arguments');
  const [command,raw]=args;if(!['calibrate','prepare','status','command'].includes(command))S.fail('lhcb02-calibration-only');
  const root=S.rootOf(raw);
  if(command==='command')return {command:[process.execPath,S.path.join(__dirname,'cli.cjs'),'calibrate',root].map(x=>"'"+x.replace(/'/g,"'\\''")+"'").join(' ')};
  if(command==='status'){S.ready(root);return S.fs.existsSync(S.inside(root,'reports/calibration.json'))?S.read(S.inside(root,'reports/calibration.json')):{status:'UNVERIFIED',officialRunCreated:false};}
  require('./prepare.cjs').prepare(root);
  S.ready(root);
  if(command==='prepare')return {prepared:true,root,providerCalls:0};
  if(!S.fs.existsSync(S.inside(root,'state/runtime.json')))load('init').stageRuntime(root,S.os.homedir()+'/.local/share/nexus');
  return new (require('./autorunner.cjs').CalibrationRunner)(root).execute();
}
if(require.main===module)main(process.argv.slice(2)).then(r=>{process.stdout.write(S.json(r));if(r.calibration?.status==='FAIL')process.exitCode=2;}).catch(e=>{process.stderr.write((/^lhcb-[a-z0-9-]+$/.test(e.message)?e.message:'lhcb02-command-failed')+'\n');process.exitCode=1;});
module.exports={main};
