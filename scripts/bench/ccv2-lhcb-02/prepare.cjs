'use strict';
const {S,load}=require('./infrastructure.cjs');
function prepare(raw,options={}){
 const root=S.rootOf(raw);const releaseLease=require('./lease.cjs').acquire(root+'.prepare-lock.json',root,options);
 try{return build(root,options);}finally{releaseLease();}
}
function build(root,options){
 const staging=S.rootOf(root+'.lhcb02-preparing'),owner=staging+'.owner.json';S.noLinks(owner);
 if(S.fs.existsSync(S.inside(root,'state/identity.json'))){S.ready(root);return {prepared:true,root,providerCalls:0};}
 if(S.fs.existsSync(root)&&S.fs.readdirSync(root).length)S.fail('init-target-not-empty');
 if(S.fs.existsSync(staging)||S.fs.existsSync(owner)){
  if(!S.fs.existsSync(owner))S.fail('lhcb02-prepare-unowned');const marker=S.read(owner);
  if(marker.root!==root||marker.staging!==staging||marker.contractHash!==S.contractHash())S.fail('lhcb02-prepare-unowned');
  // This tree was never published or submitted. Rebuild only this owned staging tree.
  if(S.fs.existsSync(staging)){S.noLinks(staging);S.fs.rmSync(staging,{recursive:true,force:true});}
 }else S.write(owner,{root,staging,contractHash:S.contractHash()});
 options.fault?.('before-init');load('init').init(staging,{noRuntime:true});options.fault?.('after-init');
 const p=S.inside(staging,'nexus-root/config/routing-policy.json');S.write(p,load('arms').configure(S.read(p),'native'));
 const identity=S.read(S.inside(staging,'state/identity.json'));identity.root=root;S.write(S.inside(staging,'state/identity.json'),identity);
 options.fault?.('before-publish');S.fs.renameSync(staging,root);S.fs.unlinkSync(owner);
 return {prepared:true,root,providerCalls:0};
}
module.exports={prepare};
