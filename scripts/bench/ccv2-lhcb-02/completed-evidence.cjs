'use strict';
// Host-only evidence. reports/ is not mounted in the isolated candidate runtime.
const {S}=require('./infrastructure.cjs');
function protect(dir){for(const e of S.fs.readdirSync(dir,{withFileTypes:true})){const p=S.inside(dir,e.name);if(e.isDirectory())protect(p);else S.fs.chmodSync(p,0o400);}S.fs.chmodSync(dir,0o500);}
function syncTree(dir){for(const e of S.fs.readdirSync(dir,{withFileTypes:true})){const p=S.inside(dir,e.name);if(e.isDirectory())syncTree(p);else syncPath(p);}syncPath(dir);}
function syncPath(p){const fd=S.fs.openSync(p,'r');try{S.fs.fsyncSync(fd);}finally{S.fs.closeSync(fd);}}
function verify(dir){
 S.noLinks(dir);const meta=S.read(S.inside(dir,'archive.json'));
 if(meta.kind!=='COMPLETED_ARM_EVIDENCE_V1'||S.fs.readFileSync(S.inside(dir,'seal.sha256'),'utf8').trim()!==S.hash(S.json(meta)))S.fail('completed-archive-seal');
 const files=S.inventory(S.inside(dir,'payload'));
 if(S.json(Object.keys(files).sort())!==S.json(Object.keys(meta.files).sort())||Object.entries(meta.files).some(([p,v])=>files[p]?.hash!==v.hash))S.fail('completed-archive-content');
 if(S.hash(S.fs.readFileSync(S.inside(dir,'run.json')))!==meta.runHash)S.fail('completed-archive-run');
 return meta;
}
function archiveCompletedArm(root,run){
 S.ready(root);if(!['native','production','forced'].includes(run.arm)||!run.grade||run.stages.at(-1)?.promptId!=='T99')S.fail('completed-archive-not-complete');
 const dir=S.inside(root,'reports/completed-arms/'+run.arm);if(S.fs.existsSync(dir))S.fail('completed-archive-exists');
 const paths=['workspace','nexus-root/data/sessions','nexus-root/data/logs','nexus-root/logs/provider-observability.jsonl','state/binding.json'];
 const files={};for(const p of paths){const full=S.inside(root,p);if(!S.fs.existsSync(full)){if(p==='workspace'||p==='nexus-root/data/sessions')S.fail('completed-archive-missing');continue;}
  if(S.fs.statSync(full).isDirectory())for(const [rel,v] of Object.entries(S.inventory(full)))files[p+'/'+rel]=v;
  else{const bytes=S.fs.readFileSync(full);S.safeBytes(bytes);files[p]={hash:S.hash(bytes),mode:S.fs.statSync(full).mode&0o777};}
 }
 const workspaceFiles=Object.fromEntries(Object.entries(files).filter(([p])=>p.startsWith('workspace/')).map(([p,v])=>[p.slice(10),v]));
 if(S.treeHash(workspaceFiles)!==run.finalWorkspaceHash)S.fail('completed-archive-workspace-drift');
 const sourceFiles=Object.fromEntries(Object.entries(workspaceFiles).filter(([p])=>p.startsWith('src/')));
 const temporary=dir+'.pending-'+S.crypto.randomUUID();S.fs.mkdirSync(S.inside(temporary,'payload'),{recursive:true,mode:0o700});
 // No rename to final, no successful return, and hence no later restore until
 // all copies have been hashed and independently verified.
 S.copyInventory(root,S.inside(temporary,'payload'),files);S.write(S.inside(temporary,'run.json'),run);
 const meta={kind:'COMPLETED_ARM_EVIDENCE_V1',arm:run.arm,contractHash:S.contractHash(),workloadHash:S.workloadHash(),candidateWorkspaceHash:run.finalWorkspaceHash,candidateSourceHash:S.treeHash(sourceFiles),files,runHash:S.hash(S.fs.readFileSync(S.inside(temporary,'run.json'))),t99:run.stages.at(-1)};
 S.write(S.inside(temporary,'archive.json'),meta);S.fs.writeFileSync(S.inside(temporary,'seal.sha256'),S.hash(S.json(meta))+'\n',{mode:0o400});verify(temporary);protect(temporary);syncTree(temporary);S.fs.renameSync(temporary,dir);syncPath(S.path.dirname(dir));
 return {relativePath:'reports/completed-arms/'+run.arm,seal:S.hash(S.json(meta)),candidateSourceHash:meta.candidateSourceHash};
}
function assertRestorable(root){
 const journal=S.inside(root,'state/official-journal.json');if(!S.fs.existsSync(journal))return;
 for(const run of S.read(journal).arms??[]){if(!run.metrics)continue;
  if(run.completedArchive?.relativePath!=='reports/completed-arms/'+run.arm)S.fail('completed-archive-required-before-restore');
  const meta=verify(S.inside(root,run.completedArchive.relativePath));
  if(S.hash(S.json(meta))!==run.completedArchive.seal||meta.candidateWorkspaceHash!==run.finalWorkspaceHash)S.fail('completed-archive-receipt');
 }
}
module.exports={archiveCompletedArm,verify,assertRestorable};
