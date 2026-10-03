'use strict';
const S=require('./state.cjs');
// Only agent request provenance qualifies. Session title/model discovery and
// current settings are not evidence for the route used by historical stages.
function observeRoute(events,source={}){
  const evidence=[];let observed;
  for(const [index,event] of events.entries()){
    const config=event.type==='request/context'?event.data:event.type==='request/header'?event.data?.header?.config:null;
    if(config==null)continue;
    if(config.provider!==S.manifest.provider||config.model!==S.manifest.model)S.fail('runner-provider-model-mismatch');
    observed={provider:config.provider,model:config.model};
    evidence.push({kind:event.type,seq:event.seq,index,eventHash:S.hash(S.json(event)),...(source.sessionLog?{locator:source.sessionLog+'#event/'+event.seq}:{}),...(source.sessionLogHash?{sessionLogHash:source.sessionLogHash}:{})});
  }
  if(!observed)S.fail('runner-provider-model-unobserved');
  return {...observed,evidence};
}
module.exports={observeRoute};
