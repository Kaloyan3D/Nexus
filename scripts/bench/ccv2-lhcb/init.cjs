'use strict';
const S=require('./state.cjs'),D=require('./doctor.cjs');
const {execFileSync}=require('node:child_process');
function init(root,options={}) {
  root=S.rootOf(root);S.validateManifest(S.manifest);
  if(S.fs.existsSync(root)&&S.fs.readdirSync(root).length)S.fail('init-target-not-empty');
  if(!D.sourceGuard().pass)S.fail('production-drift');
  for(const p of ['nexus-root','workspace','snapshots','runs','reports','state'])S.fs.mkdirSync(S.inside(root,p),{recursive:true,mode:0o700});
  const install=S.inside(root,'nexus-root');
  const tracked=S.git(S.REPO,['ls-tree','-r','--name-only',S.manifest.baseSha]).split('\n').filter(p=>/^(config|scripts|bin|runtime|ui|skills|docs)\//.test(p)&&!p.startsWith('runtime/node/')&&!p.startsWith('runtime/pwsh/'));
  for(const p of tracked){if(S.secretName(p))continue;const bytes=execFileSync('git',['show',S.manifest.baseSha+':'+p],{cwd:S.REPO,maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']});const dest=S.inside(install,p);S.fs.mkdirSync(S.path.dirname(dest),{recursive:true});S.fs.writeFileSync(dest,bytes);}
  createLaunchDirectories(install);
  const policyFile=S.inside(install,'config/routing-policy.json');S.write(policyFile,require('./arms.cjs').configure(S.read(policyFile),'production'));
  S.fs.copyFileSync(S.inside(install,'config/settings.yaml'),S.inside(install,'data/settings.yaml'));
  const fixture=require('../../../benchmarks/ccv2-lhcb-01/fixture/create-fixture.cjs').createFixture(S.inside(root,'workspace'));S.write(S.inside(root,'state/fixture.json'),fixture);
  S.write(S.inside(root,'state/identity.json'),{benchmarkId:S.manifest.benchmarkId,baseSha:S.manifest.baseSha,root,contractHash:S.contractHash()});
  if(!options.noRuntime)stageRuntime(root,options.runtimeSource||S.path.join(S.os.homedir(),'.local/share/nexus'));
  return {initialized:true,root,fixture,runtimeStaged:!options.noRuntime};
}
function stageRuntime(root,source) {
  S.ready(root);if(S.fs.readdirSync(S.inside(root,'runs')).length||S.fs.readdirSync(S.inside(root,'snapshots')).length)S.fail('runtime-staging-before-experiments-only');if(!D.sourceGuard().pass)S.fail('production-drift');S.noLinks(source);source=S.path.resolve(source);
  const install=S.inside(root,'nexus-root');if(S.fs.existsSync(S.inside(root,'state/runtime.json')))S.fs.unlinkSync(S.inside(root,'state/runtime.json'));if(source===install||source.startsWith(root+S.path.sep))S.fail('runtime-source-invalid');
  copyRuntimeDependencies(source,install);
  const node=S.inside(install,'runtime/node/bin/node'), pwsh=S.inside(install,'runtime/pwsh/pwsh');
  const versions=S.read(S.inside(install,'config/versions.json'));
  const actual=execFileSync(node,['--version'],{encoding:'utf8'}).trim();if(actual!=='v'+versions.NodeVersion)S.fail('node-version-mismatch');
  const env={PATH:process.env.PATH,HOME:root,AIH_INSTALL_ROOT:install,NEXUS_INSTALL_ROOT:install,DSH_HOME:S.inside(install,'data'),NODE_OPTIONS:'--require='+S.path.join(S.BENCH,'grader/offline.cjs')};
  for(const plane of ['muse','engineering','deepseek'])execFileSync(node,[S.inside(install,'scripts/MusePresetDependencyClosure.cjs'),'prepare',S.REPO,install,plane],{env,stdio:['ignore','pipe','pipe'],maxBuffer:2*1024*1024});
  // Invoke the existing composition authorities individually. The frozen Complete-Install final permission walk follows dependency links and can expand dramatically; the benchmark restricts its own data without following links.
  S.fs.copyFileSync(S.inside(install,'config/home.cordis.patch.yml'),S.inside(install,'data/cordis.patch.yml'));
  S.fs.copyFileSync(S.inside(install,'config/Routing-Integrity.cjs'),S.inside(install,'data/Routing-Integrity.cjs'));
  execFileSync(node,[S.inside(install,'scripts/Remove-MuseContributorEgressPatch.cjs'),install],{env,stdio:['ignore','pipe','pipe'],timeout:15000});
  for(const script of ['Patch-ControlRoomUi.ps1','Patch-NexusUi.ps1','Install-ControllerPresets.ps1','Install-MusePreset.ps1'])execFileSync(pwsh,['-NoLogo','-NoProfile','-File',S.inside(install,'scripts/'+script),'-InstallRoot',install],{env,stdio:['ignore','pipe','pipe'],maxBuffer:4*1024*1024,timeout:30000});
  execFileSync(node,[S.inside(install,'scripts/Verify-RoutingIntegrityComposition.mjs'),install],{env,stdio:['ignore','pipe','pipe'],timeout:15000});
  createLaunchDirectories(install);
  function restrict(dir){S.fs.chmodSync(dir,0o700);for(const e of S.fs.readdirSync(dir,{withFileTypes:true})){const f=S.path.join(dir,e.name);if(e.isSymbolicLink()){if(!S.fs.realpathSync(f).startsWith(install+S.path.sep))S.fail('runtime-link-escape');continue;}if(e.isDirectory())restrict(f);else S.fs.chmodSync(f,0o600);}}restrict(S.inside(install,'data'));
  // Install the canonical Linux launchers into the expected bin location.
  for(const p of S.fs.readdirSync(S.inside(install,'bin/linux')).filter(x=>x.endsWith('.sh'))){const dest=S.inside(install,'bin/'+p.slice(0,-3));S.fs.copyFileSync(S.inside(install,'bin/linux/'+p),dest);S.fs.chmodSync(dest,0o755);}
  const imports=D.runtimeImports(install);if(!imports.ready)S.fail('dependency-import-failed:'+imports.missingPackages.join(','));
  S.write(S.inside(root,'state/runtime.json'),{nodeVersion:actual,dshSessionVersion:S.read(S.inside(install,'app/node_modules/@deepseek-ai/dsh-session/package.json')).version,staged:true,immutableFiles:D.immutableRuntimeFiles(install)});
  return {staged:true};
}
function copyRuntimeDependencies(source,install) {
  S.ready(S.path.dirname(install));if(install!==S.inside(S.path.dirname(install),'nexus-root'))S.fail('runtime-target-invalid');
  S.noLinks(source);source=S.path.resolve(source);S.noLinks(install);if(source===install||source.startsWith(S.path.dirname(install)+S.path.sep)||install.startsWith(source+S.path.sep))S.fail('runtime-source-invalid');
  for(const p of ['package.json','package-lock.json'])if(S.hash(S.fs.readFileSync(S.inside(source,'app/'+p)))!==S.hash(S.fs.readFileSync(S.inside(install,'runtime/'+p))))S.fail('runtime-source-manifest-mismatch');
  const boundaries=['app/node_modules','runtime/node','runtime/pwsh'].map(p=>S.path.join(source,p));
  function checkTree(file,ancestors=new Set()){const stat=S.fs.lstatSync(file);const resolved=S.fs.realpathSync(file);if(!boundaries.some(p=>resolved===p||resolved.startsWith(p+S.path.sep)))S.fail('runtime-source-link-escape');if(stat.isSymbolicLink()&&!S.fs.existsSync(resolved))S.fail('runtime-source-link-broken');if(S.fs.statSync(file).isDirectory()){if(ancestors.has(resolved))S.fail('runtime-source-link-cycle');const next=new Set([...ancestors,resolved]);for(const name of S.fs.readdirSync(file).sort())checkTree(S.path.join(file,name),next);}else if(!S.fs.statSync(file).isFile())S.fail('runtime-source-unsupported-file');}
  for(const boundary of boundaries)checkTree(boundary);
  // Faithfully copy immutable code trees. Credential-named packages are code, not user stores.
  // Isolation is enforced by these approved source boundaries, not the mutable-state secret filter.
  for(const p of ['app/package.json','app/package-lock.json','app/node_modules','runtime/node','runtime/pwsh']){
    const from=S.inside(source,p),to=S.inside(install,p);if(!S.fs.existsSync(from))S.fail('runtime-source-incomplete');
    S.fs.rmSync(to,{recursive:true,force:true});
    S.fs.cpSync(from,to,{recursive:true,dereference:true,filter:f=>{if(S.fs.lstatSync(f).isSymbolicLink()){const target=S.fs.realpathSync(f);if(!['app/node_modules','runtime/node','runtime/pwsh'].some(p=>target===S.path.join(source,p)||target.startsWith(S.path.join(source,p)+S.path.sep)))S.fail('runtime-source-link-escape');}return true;}});
  }
}
function createLaunchDirectories(install){for(const p of D.requiredLaunchDirectories)S.fs.mkdirSync(S.inside(install,p),{recursive:true,mode:0o700});}
module.exports={init,stageRuntime,copyRuntimeDependencies,createLaunchDirectories};
