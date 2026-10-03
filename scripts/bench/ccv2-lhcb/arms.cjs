'use strict';
const S=require('./state.cjs'), D=require('./doctor.cjs'),Session=require('./session.cjs'),Snap=require('./snapshot.cjs');
function configure(policy,arm) {if(!S.manifest.arms[arm])S.fail('arm-invalid');return {...policy,contextCompiler:{...policy.contextCompiler,...S.manifest.arms[arm]}};}
function start(root,arm,options={}) {
  S.ready(root);Snap.stopped(options);
  const current=S.read(S.inside(root,'state/current.json'));if(current.arm)S.fail('restore-before-each-arm');
  const b=Session.binding(root), meta=Snap.verifySnapshot(S.inside(root,'snapshots/'+current.checkpoint));
  if(S.hash(S.json(meta))!==current.snapshotSeal||S.treeHash(S.inventory(S.inside(root,'workspace')))!==meta.workspaceHash||S.hash(S.fs.readFileSync(S.inside(root,b.sessionLog)))!==meta.sessionLogHash)S.fail('baseline-drift');
  for(const p of Snap.roots)if(S.json(S.inventory(S.inside(root,p)))!==S.json(meta.inventories[p]))S.fail('baseline-mutable-state-drift');if(S.json(Snap.mutableFiles(root))!==S.json(meta.stateFiles))S.fail('baseline-state-file-drift');
  const policyFile=S.inside(root,'nexus-root/config/routing-policy.json');
  if(S.hash(S.fs.readFileSync(policyFile))!==meta.policyHash)S.fail('baseline-policy-drift');
  const policy=configure(S.read(policyFile),arm);
  const preflight=D.doctor(root);if(!preflight.sourceGuard.pass||!preflight.runtime.ready||preflight.certification.health!=='HEALTHY')S.fail('preflight-unhealthy');
  const runId=options.runId||new Date().toISOString().replace(/[:.]/g,'-')+'-'+S.crypto.randomUUID().slice(0,8);
  if(!/^[A-Za-z0-9_-]+$/.test(runId))S.fail('run-id-invalid');
  const runDir=S.inside(root,'runs/'+runId);S.fs.mkdirSync(runDir,{recursive:false});
  const logFile=S.inside(root,'nexus-root/data/logs/aih-controller.log');
  const run={benchmarkId:S.manifest.benchmarkId,benchmarkVersion:1,contractHash:S.contractHash(),runId,checkpoint:current.checkpoint,arm,baseSha:S.manifest.baseSha,fixtureRevision:S.manifest.fixtureRevision,provider:S.manifest.provider,model:S.manifest.model,sessionId:b.sessionId,taskId:b.taskId,taskInstanceId:b.taskInstanceId,sessionLog:b.sessionLog,startSeq:b.events.length,startLogBytes:S.fs.existsSync(logFile)?S.fs.statSync(logFile).size:0,snapshotSeal:current.snapshotSeal,settingsIdentityHash:meta.settingsIdentityHash,startedAt:new Date().toISOString(),policyHash:S.hash(S.json(policy))};
  S.write(policyFile,policy);S.write(S.inside(runDir,'run.json'),run);S.write(S.inside(runDir,'preflight.json'),preflight);S.write(S.inside(root,'state/current.json'),{...current,arm,runId});return run;
}
module.exports={configure,start};
