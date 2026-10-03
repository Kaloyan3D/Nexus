'use strict';
const S=require('./state.cjs');
const wire=require('../../../config/ContextWireProjectorResponsesV2.cjs');
const gate=require('../../../config/ContextActivationPressureV2.cjs');
const host=require('../../../config/ContextCompilerActiveOpencodeHostV2.cjs');
function immutableRuntimeFiles(install){const out={};function walk(dir,rel){for(const e of S.fs.readdirSync(dir,{withFileTypes:true})){const full=S.path.join(dir,e.name),key=rel+'/'+e.name;if(e.isSymbolicLink()){const resolved=S.fs.realpathSync(full);if(!resolved.startsWith(install+S.path.sep))S.fail('runtime-link-escape');out[key]=S.hash(S.fs.readlinkSync(full));}else if(e.isDirectory())walk(full,key);else out[key]=S.hash(S.fs.readFileSync(full));}}for(const p of ['data/.agent-presets','data/profiles']){if(S.fs.existsSync(S.inside(install,p)))walk(S.inside(install,p),p);}for(const p of ['data/cordis.patch.yml','data/Routing-Integrity.cjs'])if(S.fs.existsSync(S.inside(install,p)))out[p]=S.hash(S.fs.readFileSync(S.inside(install,p)));return out;}
function sourceGuard(repo=S.REPO, installed=null) {
  const differs=[];const planes=[];if(installed&&S.fs.existsSync(S.inside(S.path.dirname(installed),'state/runtime.json'))){for(const plane of ['muse','engineering','deepseek']){try{const closure=S.read(S.inside(installed,'config/.'+plane+'-preset-closure.json'));planes.push({plane,files:closure.files});}catch{differs.push('nexus-root/config/.'+plane+'-preset-closure.json');}}}
  for(const p of S.manifest.protectedPaths) {
    let expected; try {expected=require('node:child_process').execFileSync('git',['show',S.manifest.baseSha+':'+p],{cwd:repo,maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']});} catch { S.fail('frozen-base-unavailable'); }
    try {const bytes=S.fs.readFileSync(S.inside(repo,p));const filtered=require('node:child_process').execFileSync('git',['hash-object','--path',p,'--stdin'],{cwd:repo,input:bytes,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();const frozen=S.git(repo,['rev-parse',S.manifest.baseSha+':'+p]);if(filtered!==frozen)differs.push(p);} catch {differs.push(p);}
    if(installed&&p!=='config/routing-policy.json')try {if(S.hash(S.fs.readFileSync(S.inside(installed,p)))!==S.hash(expected))differs.push('nexus-root/'+p);}catch {differs.push('nexus-root/'+p);}
    if(installed&&p.startsWith('config/'))for(const plane of planes){const name=p.slice(7);if(plane.files.some(row=>row.name===name)){const copy='data/.agent-presets/aih-'+plane.plane+'/'+name;try{if(S.hash(S.fs.readFileSync(S.inside(installed,copy)))!==S.hash(expected))differs.push('nexus-root/'+copy);}catch{differs.push('nexus-root/'+copy);}}}
    if(installed&&p.startsWith('ui/')&&planes.length){const parts=p.split('/'),moduleName=parts[1].replace(/^nexus-/,'');const copy='data/profiles/node_modules/@nexus/'+moduleName+'/'+parts.slice(2).join('/');if(S.fs.existsSync(S.path.join(installed,copy)))try{if(S.hash(S.fs.readFileSync(S.inside(installed,copy)))!==S.hash(expected))differs.push('nexus-root/'+copy);}catch{differs.push('nexus-root/'+copy);}}
  }
  if(installed&&planes.length){try{const pinned=S.read(S.inside(S.path.dirname(installed),'state/runtime.json')).immutableFiles;if(!pinned||['muse','engineering','deepseek'].some(plane=>!pinned['data/.agent-presets/aih-'+plane+'/agent.cordis.yml']))differs.push('state/runtime.json:immutable-files-missing');else{const actual=immutableRuntimeFiles(installed);for(const p of new Set([...Object.keys(pinned),...Object.keys(actual)]))if(actual[p]!==pinned[p])differs.push('nexus-root/'+p);}}catch{differs.push('state/runtime.json:immutable-files-invalid');}}
  if(installed)for(const p of ['package.json','package-lock.json']){try{if(S.hash(S.fs.readFileSync(S.inside(installed,'app/'+p)))!==S.hash(S.fs.readFileSync(S.inside(installed,'runtime/'+p))))differs.push('nexus-root/app/'+p);}catch{if(planes.length)differs.push('nexus-root/app/'+p);}}
  return {pass:differs.length===0,baseSha:S.manifest.baseSha,differingPaths:differs};
}
function route(root) {
  const install=S.inside(root,'nexus-root');
  const text=S.fs.readFileSync(S.inside(install,'config/settings.yaml'),'utf8');
  const r=wire.readResponsesRouteFromSettingsV2(text,S.manifest.provider,S.manifest.model);
  if(!gate.deriveActivationThresholdsV2(r).valid)S.fail('route-invalid');
  return r;
}
function identity(root) {
  const v=host.currentOpencodeIdentityV2({installRoot:S.inside(root,'nexus-root')});
  if(!v.known)S.fail('settings-identity-unknown');
  const actual=S.fs.readFileSync(S.inside(root,'nexus-root/data/settings.yaml'));
  S.safeBytes(actual);
  return S.hash(S.json(v.identity)+S.hash(actual));
}
function certification(root) {
  const installRoot=S.inside(root,'nexus-root');
  const v=host.startupOpencodeAuthorityV2({installRoot});return {health:v.health,state:v.state};
}
// Resolve from app/package.json and import ESM without executing provider requests or plugins.
const runtimePackages=Object.freeze(['@deepseek-ai/cordis','@deepseek-ai/dsh-session','@deepseek-ai/dsh-credentials','@deepseek-ai/dsh-credentials-local','@deepseek-ai/dsh-llm-pi-ai','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-agent','@deepseek-ai/dsh-agent-loop','@deepseek-ai/dsh-invariants','yaml']);
function runtimeImports(install){
  const node=S.inside(install,'runtime/node/bin/node');
  if(!S.fs.existsSync(node))return {ready:false,reason:'offline-runtime-staging-required',missingPackages:[]};
  const preload=S.path.join(S.BENCH,'grader/offline.cjs');
  const script=`const {createRequire}=require('node:module'),{pathToFileURL}=require('node:url');const r=createRequire(process.argv[1]);const packages=JSON.parse(process.argv[2]);(async()=>{const missing=[];for(const p of packages){try{const mod=await import(pathToFileURL(r.resolve(p)).href);if(p==='@deepseek-ai/dsh-session'&&typeof mod.decodeStorageRecord!=='function')throw new Error('codec');}catch{missing.push(p);}}process.stdout.write(JSON.stringify({missing,nodeVersion:process.version,networkAttempts:global.lhcbOfflineAudit.attempts()}));})().catch(()=>{process.exitCode=1;});`;
  try{
    const output=require('node:child_process').execFileSync(node,['--require',preload,'-e',script,S.inside(install,'app/package.json'),JSON.stringify(runtimePackages)],{env:{PATH:process.env.PATH,HOME:S.path.dirname(install),AIH_INSTALL_ROOT:install,NEXUS_INSTALL_ROOT:install,DSH_HOME:S.inside(install,'data')},encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:64*1024});
    const result=JSON.parse(output),pinned='v'+S.read(S.inside(install,'config/versions.json')).NodeVersion;
    if(result.nodeVersion!==pinned)return {ready:false,reason:'node-version-mismatch',missingPackages:[]};
    if(result.networkAttempts!==0||!Array.isArray(result.missing))throw new Error('invalid-import-probe');
    return {ready:result.missing.length===0,reason:result.missing.length?'dependency-import-failed':null,missingPackages:result.missing};
  }catch{return {ready:false,reason:'dependency-import-failed',missingPackages:[...runtimePackages]};}
}
function doctor(root) {
  S.validateManifest(S.manifest); root=S.rootOf(root);
  const initialized=S.fs.existsSync(S.inside(root,'state/identity.json'));
  const guard=sourceGuard(S.REPO,initialized?S.inside(root,'nexus-root'):null);
  let runtime={ready:false,reason:'init-required'},thresholds=null,cert=null;
  if(initialized){S.ready(root); thresholds=gate.deriveActivationThresholdsV2(route(root)); cert=certification(root);
    runtime=runtimeImports(S.inside(root,'nexus-root'));
    if(runtime.ready&&(!S.fs.existsSync(S.inside(root,'nexus-root/runtime/pwsh/pwsh'))||!S.fs.existsSync(S.inside(root,'state/runtime.json'))))runtime={...runtime,ready:false,reason:'runtime-composition-incomplete'};
  }
  return {benchmarkId:S.manifest.benchmarkId,sourceGuard:guard,initialized,runtime,thresholds,certification:cert,liveReady:guard.pass&&runtime.ready&&cert?.health==='HEALTHY'};
}
module.exports={runtimeImports,runtimePackages,immutableRuntimeFiles,sourceGuard,route,identity,certification,doctor};
