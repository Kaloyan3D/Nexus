'use strict';
const {S,load}=require('./infrastructure.cjs');
const excluded=new Set(['profiles','.agent-presets','tmp','settings.yaml','cordis.patch.yml','Routing-Integrity.cjs','install-source-root']);
function selected(root){
 const paths=['workspace'];for(const name of S.fs.readdirSync(S.inside(root,'state')))if(/^release-(?:E\d{2}|T99)\.json$/.test(name))paths.push('state/'+name);for(const e of S.fs.readdirSync(S.inside(root,'nexus-root/data'),{withFileTypes:true}))if(!excluded.has(e.name)&&!S.secretName(e.name))paths.push('nexus-root/data/'+e.name);
 const files={};for(const p of paths){const full=S.inside(root,p);if(S.fs.statSync(full).isDirectory())for(const [rel,v] of Object.entries(S.inventory(full)))files[p+'/'+rel]=v;else{const bytes=S.fs.readFileSync(full);S.safeBytes(bytes);files[p]={hash:S.hash(bytes),mode:S.fs.statSync(full).mode&0o777};}}
 return {paths:paths.sort(),files};
}
function verify(dir){
 S.noLinks(dir);const meta=S.read(S.inside(dir,'snapshot.json'));
 if(meta.kind!=='LIVE_PROGRESSIVE_CP500'||meta.workloadHash!==S.workloadHash()||S.fs.readFileSync(S.inside(dir,'seal.sha256'),'utf8').trim()!==S.hash(S.json(meta)))S.fail('lhcb02-official-snapshot-seal');
 if(meta.pressureTokens<480000||meta.pressureTokens>550000||meta.identity?.provider!==S.manifest.provider||meta.identity?.model!==S.manifest.model)S.fail('lhcb02-official-snapshot-authority');
 const actual=S.inventory(S.inside(dir,'payload'));
 if(S.json(Object.keys(actual).sort())!==S.json(Object.keys(meta.files).sort())||Object.entries(meta.files).some(([p,v])=>actual[p]?.hash!==v.hash))S.fail('lhcb02-official-snapshot-content');return meta;
}
function memoryReady(root){
 const b=load('session').binding(root),end=b.events.findLast(e=>e.type==='turn/end');if(!end)return false;
 const dir=S.inside(root,'workspace/.ai-harness/ccv2/'+b.taskId);let state,staged;
 try{state=S.read(S.inside(dir,'producer/state.json'));staged=S.read(S.inside(dir,'staged.json'));}catch{return false;}
 for(const k of ['sessionId','taskId','taskInstanceId'])if(state.namespace?.[k]!==b[k])S.fail('lhcb02-official-memory-identity');
 if(state.namespace.workspaceId!==S.inside(root,'workspace'))S.fail('lhcb02-official-memory-identity');
 if(state.blocker||staged.blocker)S.fail('lhcb02-official-memory-blocked');
 return state.openTurn===null&&staged.activeTurn===null&&state.processedThroughSeq>=end.seq&&staged.processedThroughSeq>=end.seq&&state.sealedGeneration>0&&state.sealedGeneration===staged.sealedGeneration&&state.sealedCheckpointId===staged.sealedCheckpointId;
}
function seal(root,{identity,completedStages,pressureTokens,protocolHash}){
 S.ready(root);const session=load('session').binding(root),p=load('session').currentPressure(root);
 if(p.pressureTokens!==pressureTokens||pressureTokens<480000||pressureTokens>550000||session.sessionId!==identity.sessionId||session.taskInstanceId!==identity.taskInstanceId)S.fail('lhcb02-official-checkpoint-pressure');
 if(session.events.some(e=>e.type.startsWith('compaction/')||e.surfaceOp&&e.surfaceOp!=='append'))S.fail('lhcb02-official-checkpoint-history');
 if(!session.events.findLast(e=>e.type==='turn/end'&&e.data.reason?.kind==='completed'))S.fail('lhcb02-official-checkpoint-incomplete');
 if(!memoryReady(root))S.fail('lhcb02-official-memory-incomplete');
 const chosen=selected(root),dir=S.inside(root,'snapshots/CP-500');if(S.fs.existsSync(dir))S.fail('lhcb02-official-snapshot-exists');S.fs.mkdirSync(S.inside(dir,'payload'),{recursive:true});
 for(const [p,v] of Object.entries(chosen.files)){const file=S.inside(dir,'payload/'+p);S.fs.mkdirSync(S.path.dirname(file),{recursive:true});const bytes=S.fs.readFileSync(S.inside(root,p));if(S.hash(bytes)!==v.hash)S.fail('lhcb02-official-checkpoint-changed');S.fs.writeFileSync(file,bytes,{mode:v.mode});}
 const meta={kind:'LIVE_PROGRESSIVE_CP500',root,checkpoint:'CP-500',workloadHash:S.workloadHash(),contractHash:S.contractHash(),protocolHash,identity,completedStages,pressureTokens,paths:chosen.paths,files:chosen.files,baselineHash:S.treeHash(chosen.files),sessionLogHash:session.sessionLogHash,binding:S.read(S.inside(root,'state/binding.json')),settingsIdentity:load('doctor').identity(root)};
 S.write(S.inside(dir,'snapshot.json'),meta);S.fs.writeFileSync(S.inside(dir,'seal.sha256'),S.hash(S.json(meta))+'\n',{mode:0o400});verify(dir);
 function protect(path){for(const e of S.fs.readdirSync(path,{withFileTypes:true})){const file=S.path.join(path,e.name);if(e.isDirectory())protect(file);else S.fs.chmodSync(file,0o400);}S.fs.chmodSync(path,0o500);}protect(dir);return meta;
}
function restore(root){
 S.owned(root);const dir=S.inside(root,'snapshots/CP-500'),meta=verify(dir);
 if(meta.root!==root||meta.settingsIdentity!==load('doctor').identity(root)||!load('doctor').sourceGuard(S.REPO,S.inside(root,'nexus-root')).pass)S.fail('lhcb02-official-restore-authority');
 // Source is fully verified before any deletion; failure locks this root.
 S.write(S.inside(root,'state/restore-lock.json'),{checkpoint:'CP-500',seal:S.hash(S.json(meta))});
 for(const p of new Set([...selected(root).paths,...meta.paths])){const file=S.inside(root,p);S.fs.rmSync(file,{recursive:true,force:true});}
 for(const p of meta.paths)if(p==='workspace'||!Object.hasOwn(meta.files,p))S.fs.mkdirSync(S.inside(root,p),{recursive:true});
 for(const [p,v] of Object.entries(meta.files)){const file=S.inside(root,p);S.fs.mkdirSync(S.path.dirname(file),{recursive:true});S.fs.writeFileSync(file,S.fs.readFileSync(S.inside(dir,'payload/'+p)),{mode:v.mode});}
 if(S.json(selected(root))!==S.json({paths:meta.paths,files:meta.files}))S.fail('lhcb02-official-restore-mismatch');
 S.write(S.inside(root,'state/binding.json'),meta.binding);load('init').createLaunchDirectories(S.inside(root,'nexus-root'));
 const b=load('session').binding(root);if(b.sessionLogHash!==meta.sessionLogHash||load('session').currentPressure(root).pressureTokens!==meta.pressureTokens)S.fail('lhcb02-official-restore-session');
 S.fs.unlinkSync(S.inside(root,'state/restore-lock.json'));return meta;
}
module.exports={selected,seal,restore,verify,memoryReady};
