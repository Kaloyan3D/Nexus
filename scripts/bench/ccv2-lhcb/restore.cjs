'use strict';
const S=require('./state.cjs'),Snap=require('./snapshot.cjs'),D=require('./doctor.cjs'),Session=require('./session.cjs');
function restore(root,id,options={}) {
  S.owned(root);Snap.stopped(options);if(!S.manifest.checkpoints.includes(id))S.fail('checkpoint-invalid');
  const dir=S.inside(root,'snapshots/'+id),meta=Snap.verifySnapshot(dir);
  if(D.identity(root)!==meta.settingsIdentityHash)S.fail('settings-identity-drift');
  if(!D.sourceGuard(S.REPO,S.inside(root,'nexus-root')).pass)S.fail('production-drift');
  // All source hashes are checked before any destruction. Failure after this point locks all further work.
  S.write(S.inside(root,'state/restore-lock.json'),{checkpoint:id});
  for(const p of Snap.roots){const dest=S.inside(root,p);S.fs.rmSync(dest,{recursive:true,force:true});S.fs.mkdirSync(dest,{recursive:true});S.copyInventory(S.inside(dir,'payload/'+p),dest,meta.inventories[p]);if(S.json(S.inventory(dest))!==S.json(meta.inventories[p]))S.fail('restore-hash-mismatch');}
  for(const p of Object.keys(Snap.mutableFiles(root)))S.fs.unlinkSync(S.inside(root,p));
  for(const [p,info] of Object.entries(meta.stateFiles)){const bytes=S.fs.readFileSync(S.inside(dir,'payload/'+p));S.fs.writeFileSync(S.inside(root,p),bytes,{mode:info.mode});if(S.hash(S.fs.readFileSync(S.inside(root,p)))!==info.hash)S.fail('restore-state-file-mismatch');}
  const bytes=S.fs.readFileSync(S.inside(dir,'payload/nexus-root/config/routing-policy.json'));
  S.fs.writeFileSync(S.inside(root,'nexus-root/config/routing-policy.json'),bytes,{mode:0o600});
  if(S.hash(S.fs.readFileSync(S.inside(root,'nexus-root/config/routing-policy.json')))!==meta.policyHash)S.fail('restore-policy-mismatch');
  S.write(S.inside(root,'state/binding.json'),meta.binding);S.write(S.inside(root,'state/stages.json'),meta.stages);Session.binding(root);
  S.write(S.inside(root,'state/current.json'),{checkpoint:id,snapshotSeal:S.hash(S.json(meta)),arm:null,runId:null});
  S.fs.unlinkSync(S.inside(root,'state/restore-lock.json'));return {restored:id,verified:true};
}
module.exports={restore};
