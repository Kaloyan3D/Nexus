'use strict';
const S=require('./state.cjs'), D=require('./doctor.cjs'), Session=require('./session.cjs');
const roots=['workspace','nexus-root/data/sessions','nexus-root/data/routing','nexus-root/data/ccv2-authority','nexus-root/data/completion','nexus-root/data/evaluation','nexus-root/data/attachments','nexus-root/data/intelligence','nexus-root/data/storages'];
const immutableData=['profiles','.agent-presets','logs','tmp','settings.yaml','cordis.patch.yml','Routing-Integrity.cjs','install-source-root'];
function mutableFiles(root){const out={};const data=S.inside(root,'nexus-root/data');for(const e of S.fs.readdirSync(data,{withFileTypes:true})){if(immutableData.includes(e.name)||S.secretName(e.name))continue;const p='nexus-root/data/'+e.name;S.noLinks(S.inside(root,p));if(e.isDirectory()){if(!roots.includes(p))S.fail('unmapped-mutable-data');}else if(e.isFile()){const bytes=S.fs.readFileSync(S.inside(root,p));S.safeBytes(bytes);out[p]={hash:S.hash(bytes),mode:S.fs.statSync(S.inside(root,p)).mode&0o777};}else S.fail('unsupported-file');}return out;}
function stopped(options) {if(options?.stopped!==true)S.fail('stop-runtime-and-pass-stopped');}
function createSnapshot(root,checkpointId,options={}) {
  S.ready(root);stopped(options);
  if(!S.manifest.checkpoints.includes(checkpointId))S.fail('checkpoint-invalid');
  if(!D.sourceGuard().pass)S.fail('production-drift');
  const target=S.inside(root,'snapshots/'+checkpointId);if(S.fs.existsSync(target))S.fail('snapshot-exists');
  const b=Session.binding(root);const stages=S.read(S.inside(root,'state/stages.json'));if(!S.manifest.stages.slice(0,8).every(id=>stages.some(x=>x.stage===id))||stages.some(x=>x.stage==='T99'))S.fail('checkpoint-requires-read-only-audits');Session.verifyStages(root,b,stages);
  const fixture=S.read(S.inside(root,'state/fixture.json'));if(S.git(S.inside(root,'workspace'),['rev-parse','HEAD'])!==fixture.commit)S.fail('checkpoint-git-history-modified');for(const [p,h] of Object.entries(fixture.fileHashes))if(S.hash(S.fs.readFileSync(S.inside(root,'workspace/'+p)))!==h)S.fail('checkpoint-source-modified');for(const p of Object.keys(S.inventory(S.inside(root,'workspace'))))if(!p.startsWith('.git/')&&!p.startsWith('.ai-harness/')&&!Object.hasOwn(fixture.fileHashes,p))S.fail('checkpoint-unexpected-workspace-file');
  const pressure=Session.currentPressure(root), threshold=pressure.dshThresholdTokens;
  const inBand= checkpointId==='CP-500'?pressure.pressureTokens>=480000&&pressure.pressureTokens<=550000:checkpointId==='CP-750'?pressure.pressureTokens>=720000&&pressure.pressureTokens<=790000:checkpointId==='CP-PRE-DSH'?pressure.pressureTokens>=threshold-65536&&pressure.pressureTokens<threshold:pressure.pressureTokens>=pressure.activationTokens;
  if(!inBand)S.fail('checkpoint-outside-band');
  const binds=S.read(S.inside(root,'nexus-root/data/routing/session-bindings.json'));
  if(Object.keys(binds.bindings).length!==1)S.fail('exclusive-benchmark-session-required');
  const stateFiles=mutableFiles(root);
  // Check every Git blob (including unreachable objects), so compressed objects cannot hide secrets.
  const gitObjects=S.git(S.inside(root,'workspace'),['cat-file','--batch-all-objects','--batch-check=%(objectname) %(objecttype)']).split('\n');for(const object of gitObjects){const [id,type]=object.split(' ');if(['blob','commit','tree'].includes(type)){const bytes=require('node:child_process').execFileSync('git',['cat-file','-p',id],{cwd:S.inside(root,'workspace'),maxBuffer:64*1024*1024});S.safeBytes(bytes);if(type==='tree'&&bytes.toString('utf8').split('\n').some(line=>S.secretName(line.split('\t')[1]||'')))S.fail('credential-in-git-history');}}
  const inventories={};for(const p of roots){const full=S.inside(root,p);if(!S.fs.existsSync(full))S.fs.mkdirSync(full,{recursive:true});inventories[p]=S.inventory(full);}
  const policy=S.fs.readFileSync(S.inside(root,'nexus-root/config/routing-policy.json'));S.safeBytes(policy);
  const workspaceTree=S.git(S.inside(root,'workspace'),['rev-parse','HEAD^{tree}']);
  const meta={benchmarkId:S.manifest.benchmarkId,benchmarkVersion:1,contractHash:S.contractHash(),baseSha:S.manifest.baseSha,checkpointId,createdAt:options.createdAt||new Date().toISOString(),provider:S.manifest.provider,model:S.manifest.model,sessionId:b.sessionId,taskId:b.taskId,taskInstanceId:b.taskInstanceId,sessionLog:b.sessionLog,pressureTokens:pressure.pressureTokens,activationBasis:pressure.basis,activationTokens:pressure.activationTokens,workspaceTree,workspaceHash:S.treeHash(inventories.workspace),sessionLogHash:S.hash(S.fs.readFileSync(S.inside(root,b.sessionLog))),ccv2StateHash:S.treeHash(Object.fromEntries(Object.entries(inventories.workspace).filter(([p])=>p.startsWith('.ai-harness/')))),policyHash:S.hash(policy),settingsIdentityHash:D.identity(root),fixtureRevision:S.manifest.fixtureRevision,inventories,stateFiles,binding:{sessionId:b.sessionId,taskId:b.taskId,taskInstanceId:b.taskInstanceId,sessionLog:b.sessionLog},stages:S.fs.existsSync(S.inside(root,'state/stages.json'))?S.read(S.inside(root,'state/stages.json')):[]};
  S.validateSchema(meta,'snapshot');
  const tmp=S.inside(root,'snapshots/.staging-'+S.crypto.randomUUID());S.fs.mkdirSync(tmp,{recursive:true});
  try {
    for(const p of roots){S.fs.mkdirSync(S.inside(tmp,'payload/'+p),{recursive:true});S.copyInventory(S.inside(root,p),S.inside(tmp,'payload/'+p),inventories[p]);}
    for(const [p,info] of Object.entries(stateFiles)){const full=S.inside(tmp,'payload/'+p);S.fs.mkdirSync(S.path.dirname(full),{recursive:true});const bytes=S.fs.readFileSync(S.inside(root,p));if(S.hash(bytes)!==info.hash)S.fail('source-changed');S.fs.writeFileSync(full,bytes,{mode:info.mode});}
    const pol=S.inside(tmp,'payload/nexus-root/config/routing-policy.json');S.fs.mkdirSync(S.path.dirname(pol),{recursive:true});S.fs.writeFileSync(pol,policy,{mode:0o400});
    S.write(S.inside(tmp,'snapshot.json'),meta);S.fs.writeFileSync(S.inside(tmp,'seal.sha256'),S.hash(S.json(meta))+'\n');
    verifySnapshot(tmp);
    function seal(dir){for(const e of S.fs.readdirSync(dir,{withFileTypes:true})){const f=S.path.join(dir,e.name);if(e.isDirectory())seal(f);else S.fs.chmodSync(f,0o400);}S.fs.chmodSync(dir,0o500);}seal(tmp);
    S.fs.renameSync(tmp,target);
  } catch(e) {if(S.fs.existsSync(tmp))S.fs.rmSync(tmp,{recursive:true,force:true});throw e;}
  return meta;
}
function verifySnapshot(dir) {
  S.noLinks(dir);const meta=S.read(S.inside(dir,'snapshot.json'));S.validateSchema(meta,'snapshot');
  if(meta.contractHash!==S.contractHash()||meta.baseSha!==S.manifest.baseSha||meta.benchmarkId!==S.manifest.benchmarkId||meta.fixtureRevision!==S.manifest.fixtureRevision||!S.manifest.checkpoints.includes(meta.checkpointId)||S.json(Object.keys(meta.inventories).sort())!==S.json(roots.slice().sort()))S.fail('snapshot-identity-invalid');
  if(S.fs.readFileSync(S.inside(dir,'seal.sha256'),'utf8').trim()!==S.hash(S.json(meta)))S.fail('snapshot-seal-mismatch');
  for(const p of roots){const dest=S.inside(dir,'payload/'+p);if(!S.fs.existsSync(dest)&&!Object.keys(meta.inventories[p]).length)continue;if(S.json(Object.fromEntries(Object.entries(S.inventory(dest)).map(([k,v])=>[k,v.hash])))!==S.json(Object.fromEntries(Object.entries(meta.inventories[p]).map(([k,v])=>[k,v.hash]))))S.fail('snapshot-hash-mismatch');}
  // Before sealing, payload retains original modes. Hash integrity does not depend on permission changes.
  for(const [p,info] of Object.entries(meta.stateFiles)){if(!/^nexus-root\/data\/[^/]+$/.test(p)||immutableData.includes(S.path.basename(p))||S.secretName(p))S.fail('snapshot-state-file-invalid');if(S.hash(S.fs.readFileSync(S.inside(dir,'payload/'+p)))!==info.hash)S.fail('snapshot-state-file-mismatch');}
  if(S.hash(S.fs.readFileSync(S.inside(dir,'payload/nexus-root/config/routing-policy.json')))!==meta.policyHash)S.fail('snapshot-policy-mismatch');
  return meta;
}
module.exports={roots,mutableFiles,stopped,createSnapshot,verifySnapshot};
