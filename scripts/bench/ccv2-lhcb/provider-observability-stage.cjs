'use strict';
const fs=require('node:fs'),path=require('node:path');
const files=['provider-observability.cjs','provider-observability-preload.cjs'];
function stage(S,root){
 if(S.manifest.benchmarkId!=='CCV2-LHCB-02')return {};
 try{const install=S.inside(root,'nexus-root'),relative='scripts/bench/ccv2-lhcb';
 for(const name of files){const to=S.inside(install,relative+'/'+name);fs.mkdirSync(path.dirname(to),{recursive:true});let existing;try{existing=fs.lstatSync(to);}catch(e){if(e.code!=='ENOENT')throw e;}if(existing&&(!existing.isFile()||existing.nlink!==1))throw Error('observer-nonprivate-module');fs.copyFileSync(path.join(__dirname,name),to);}
 return {NODE_OPTIONS:'--require='+JSON.stringify(S.inside(install,relative+'/provider-observability-preload.cjs')),LHCB_PROVIDER_OBSERVABILITY_FILE:S.inside(install,'logs/provider-observability.jsonl'),LHCB_PROVIDER_CONTEXT_FILE:S.inside(install,'logs/provider-observability-context.json')};}catch{return {};}
}
function phaseContext(S,root,sessionId,rpcId){
 if(S.manifest.benchmarkId!=='CCV2-LHCB-02')return;
 try{let phase=null;for(const name of ['official-journal.json','calibration-journal.json']){const p=S.inside(root,'state/'+name);if(!fs.existsSync(p))continue;const journal=JSON.parse(fs.readFileSync(p,'utf8'));const stages=[...(journal.stages||[]),...(journal.arms||[]).flatMap(a=>a.stages||[])];const stage=stages.findLast(x=>x.rpcId===rpcId&&x.sessionId===sessionId);if(stage){phase=stage.promptId;break;}}
  S.write(S.inside(root,'nexus-root/logs/provider-observability-context.json'),{sessionId,benchmarkRpcId:rpcId,benchmarkPhase:phase});
 }catch{/* Sidecar failure cannot change submission behavior. */}
}
module.exports={stage,phaseContext,files};
