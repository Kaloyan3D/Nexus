'use strict';
const fs=require('node:fs'),path=require('node:path');
function audit(files){
 const rows=[];for(const file of files)for(const line of fs.readFileSync(file,'utf8').split('\n')){let d;try{d=JSON.parse(line);}catch{continue;}if(d.event!=='ccv2-opencode-active-decided'||d.fallbackReason!=='active-tokenizer-unavailable')continue;
  const stage=d.attemptFailureStage??d.fallbackStage??null,kind=d.counterFailureKind??null;
  const classification=['counter-deadline','counter-gate-open','counter-rate-limited','counter-transient'].includes(kind)?'TRANSIENT_TOKENIZER_AVAILABILITY':'OTHER';
  rows.push({file,requestSeq:d.requestSeq,stage,classification,kind,httpStatus:d.counterHttpStatus??null,netErrorCode:d.counterNetErrorCode??null,exhaustReason:d.counterExhaustReason??null,deadlineMs:d.counterDeadlineMs??null,elapsedMs:d.counterElapsedMs??null,httpRequests:d.counterHttpRequests??null,cacheHits:d.counterCacheHits??null,cacheMisses:d.counterCacheMisses??null,source:d.counterSource??null,gateState:d.counterGateState??null});
 }
 const totals=key=>rows.reduce((out,r)=>{const k=r[key]??'unavailable';out[k]=(out[k]??0)+1;return out;},{});
 return {requests:rows.length,stages:totals('stage'),failureKinds:totals('kind'),classifications:totals('classification'),rows};
}
if(require.main===module)process.stdout.write(JSON.stringify(audit(process.argv.slice(2).map(p=>path.resolve(p))),null,2)+'\n');
module.exports={audit};
