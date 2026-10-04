'use strict';
const {S,load}=require('./infrastructure.cjs');
async function probe(root){
 S.ready(root);
 if(!global.lhcbBootstrapNetwork||global.lhcbBootstrapNetwork.attempts()!==0)S.fail('lhcb02-bootstrap-network-block-required');
 for(const file of ['state/calibration-journal.json','state/binding.json','state/simulation.json'])if(S.fs.existsSync(S.inside(root,file)))S.fail('lhcb02-bootstrap-probe-new-root-required');
 const release=require('./lease.cjs').acquire(S.inside(root,'state/calibration-lock.json'),root);
 try{
  const runner=new (require('./autorunner.cjs').CalibrationRunner)(root);
  await runner.prepareController();
  const report={...runner.journal.creation.authority,kind:'BOOTSTRAP_ONLY',productionBaseSha:S.manifest.baseSha,bindingRoutingLedgerAgreement:'PASS',attempt:0,promptCalls:0,providerNetworkAttempts:global.lhcbBootstrapNetwork.attempts(),sourceGuard:load('doctor').sourceGuard(S.REPO,S.inside(root,'nexus-root'))};
  if(report.providerNetworkAttempts!==0||runner.journal.stages.length!==0||!report.sourceGuard.pass)S.fail('lhcb02-bootstrap-probe-invalid');
  S.write(S.inside(root,'reports/bootstrap-probe.json'),report);return report;
 }finally{release();}
}
module.exports={probe};
