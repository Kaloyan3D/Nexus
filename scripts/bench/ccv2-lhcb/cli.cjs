#!/usr/bin/env node
'use strict';
const S=require('./state.cjs');
function runnerOptions(argv){
  const [command,arg]=argv,needsArg=['run-stage','run-until','run-arms'].includes(command);let index=needsArg?2:1;
  if(needsArg&&(!arg||arg.startsWith('--')))S.fail('runner-arguments-invalid');
  const options={},seen=new Set();for(;index<argv.length;index++){
    const flag=argv[index];if(seen.has(flag))S.fail('runner-arguments-invalid');seen.add(flag);
    if(flag==='--new-session'&&['run-stage','run-until','run-all'].includes(command))options.newSession=true;
    else if(flag==='--repeat'&&command==='run-stage')options.repeat=true;
    else if(flag==='--stage-id'&&command==='run-stage'){const id=argv[++index];if(!id||!/^stage-[A-Za-z0-9_-]{1,80}$/.test(id))S.fail('runner-stage-id-invalid');options.stageId=id;}
    else if(flag==='--max-stages'&&['run-until','run-all'].includes(command)){const raw=argv[++index];if(!raw||!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)<1||Number(raw)>10000)S.fail('runner-stage-budget-invalid');options.maxStages=Number(raw);}
    else S.fail('runner-arguments-invalid');
  }
  return options;
}
function main(argv) {
  const [command,arg]=argv;const root=S.rootOf();const stopped=argv.includes('--stopped');
  switch(command){
    case 'run-stage':case 'run-until':case 'run-arms':case 'run-all':case 'run-status':return new (require('./autorunner.cjs').AutoRunner)(root).execute(command,arg,runnerOptions(argv));
    case 'doctor':{const d=require('./doctor.cjs').doctor(root);if(!d.sourceGuard.pass)process.exitCode=1;return d;}
    case 'init':return require('./init.cjs').init(root,{noRuntime:argv.includes('--no-runtime'),runtimeSource:argv.includes('--runtime-source')?argv[argv.indexOf('--runtime-source')+1]:undefined});
    case 'stage-runtime':return require('./init.cjs').stageRuntime(root,arg);
    case 'bind':return require('./session.cjs').bind(root,arg);
    case 'status':{S.ready(root);const d=require('./doctor.cjs').doctor(root);let pressure=null;try{pressure=require('./session.cjs').currentPressure(root);}catch{}return {benchmarkId:S.manifest.benchmarkId,baseSha:S.manifest.baseSha,provider:S.manifest.provider,model:S.manifest.model,certification:d.certification,currentPressure:pressure,thresholds:d.thresholds,current:S.fs.existsSync(S.inside(root,'state/current.json'))?S.read(S.inside(root,'state/current.json')):null,snapshots:S.fs.readdirSync(S.inside(root,'snapshots')).filter(p=>S.manifest.checkpoints.includes(p))};}
    case 'prompt':{const p=require('./session.cjs').prompt(root,arg,{repeat:argv.includes('--repeat')});process.stderr.write(S.json(p.record));process.stdout.write(p.text);return undefined;}
    case 'snapshot':return require('./snapshot.cjs').createSnapshot(root,arg,{stopped});
    case 'snapshots':S.ready(root);return S.fs.readdirSync(S.inside(root,'snapshots')).filter(p=>S.manifest.checkpoints.includes(p)).map(p=>require('./snapshot.cjs').verifySnapshot(S.inside(root,'snapshots/'+p)));
    case 'restore':return require('./restore.cjs').restore(root,arg,{stopped});
    case 'arm':return require('./arms.cjs').start(root,arg,{stopped});
    case 'collect':return require('./collect.cjs').collect(root,arg,{stopped});
    case 'grade':return require('./collect.cjs').gradeRun(root,arg);
    case 'report':return require('./report.cjs').report(root);
    default:S.fail('command-required-doctor-init-stage-runtime-bind-status-prompt-snapshot-snapshots-restore-arm-collect-grade-report-run-stage-run-until-run-arms-run-all-run-status');
  }
}
module.exports={main,runnerOptions};
if(require.main===module)Promise.resolve().then(()=>main(process.argv.slice(2))).then(out=>{if(out!==undefined)process.stdout.write(S.json(out));}).catch(e=>{process.stderr.write(/^lhcb-[a-z0-9-]+$/.test(e.message)?e.message+'\n':'lhcb-operation-failed\n');process.exitCode=1;});
