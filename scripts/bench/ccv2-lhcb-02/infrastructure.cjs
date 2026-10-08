'use strict';
// Load the frozen harness with an explicit benchmark-local dependency seam.
// No source rewriting, global require-cache mutation, or production patching.
const Module=require('node:module'),legacy=require('../ccv2-lhcb/state.cjs');
const {fs,path}=legacy;
const PRODUCTION_BASE='e0282c11d5bee29359c277cd5a9568ca13d62885';
const BENCH=path.join(legacy.REPO,'benchmarks/ccv2-lhcb-02');
const definition=require(path.join(BENCH,'manifest.json'));
const manifest={...definition,baseSha:definition.productionBaseSha,protectedPaths:legacy.manifest.protectedPaths,
  stages:['T00',...definition.calibration.phases],checkpoints:Object.keys(definition.checkpoints)};
function contractHash(){
  const files=['manifest.json','phase-manifest.json','obligations.json','CONTRACT.md','SCRATCH-PROTOCOL.md','E05-REVISION.md',...fs.readdirSync(path.join(BENCH,'fixture')).sort().map(f=>'fixture/'+f),...fs.readdirSync(path.join(BENCH,'grader')).sort().map(f=>'grader/'+f),
    ...fs.readdirSync(path.join(BENCH,'prompts')).sort().map(f=>'prompts/'+f)];
  const code=fs.readdirSync(__dirname).filter(f=>f.endsWith('.cjs')&&!f.startsWith('official-')).sort();
  const reused=fs.readdirSync(path.resolve(__dirname,'../ccv2-lhcb')).filter(f=>f.endsWith('.cjs')).sort().map(f=>f+'\0'+fs.readFileSync(path.resolve(__dirname,'../ccv2-lhcb',f),'utf8')).join('\0');
  return legacy.hash(reused+files.map(f=>f+'\0'+fs.readFileSync(path.join(BENCH,f),'utf8')).join('\0')+code.map(f=>f+'\0'+fs.readFileSync(path.join(__dirname,f),'utf8')).join('\0'));
}
// The calibrated scientific workload is independent of later official orchestration.
function workloadHash(){
 const policy={workloadRevision:definition.workloadRevision,protocolRevision:definition.protocolRevision,scratch:definition.scratch,productionBaseSha:definition.productionBaseSha,provider:definition.provider,model:definition.model,arms:definition.arms,checkpoints:definition.checkpoints,officialCheckpoint:definition.officialCheckpoint,minimumContinuationPhases:definition.minimumContinuationPhases,calibration:definition.calibration,acceptance:definition.acceptance};
 const files=['phase-manifest.json','obligations.json',...['fixture','grader','prompts'].flatMap(dir=>fs.readdirSync(path.join(BENCH,dir)).sort().map(f=>dir+'/'+f))];
 return legacy.hash(legacy.json(policy)+files.map(f=>f+'\0'+fs.readFileSync(path.join(BENCH,f),'utf8')).join('\0'));
}
const S={...legacy,BENCH,manifest,contractHash,workloadHash};
S.rootOf=raw=>{
  const root=legacy.rootOf(raw);
  const old=path.join(legacy.os.homedir(),'nexus-bench/ccv2-lhcb-01');
  if(/(?:^|-)20261004(?:-02)?$/.test(path.basename(root)))S.fail('lhcb02-historical-root');
  if(root===old||root.startsWith(old+path.sep)||old.startsWith(root+path.sep))S.fail('lhcb02-historical-root');
  return root;
};
S.owned=root=>{root=S.rootOf(root);const m=S.read(S.inside(root,'state/identity.json'));
  if(m.benchmarkId!==manifest.benchmarkId||m.root!==root||m.baseSha!==manifest.baseSha||(m.contractHash!==contractHash()&&!require('./certification.cjs').compatible(root,m)))S.fail('lhcb02-unowned-root');return root;};
S.ready=root=>{S.owned(root);if(fs.existsSync(S.inside(root,'state/restore-lock.json')))S.fail('restore-incomplete');};
S.validateManifest=m=>{if(m.officialCheckpoint!=='CP-750'||m.minimumContinuationPhases!==4||m.workloadRevision!=='projection-continuation-v1'||m.protocolRevision!=='scratch-v1'||legacy.json(m.scratch)!==legacy.json({directory:'scratch',environment:'LHCB_SCRATCH',reset:'before-and-after-every-phase',snapshot:'excluded-and-empty',links:'forbidden'})||m.benchmarkId!=='CCV2-LHCB-02'||m.status!=='UNFROZEN'||m.liveCalibration!=='LIVE_CALIBRATION_REQUIRED'||m.officialExecutionEnabled!==false||m.nodeVersion!=='v24.18.1'||
  legacy.json(m.arms)!==legacy.json(legacy.manifest.arms)||legacy.json(m.acceptance)!==legacy.json(legacy.manifest.acceptance)||
  m.baseSha!==PRODUCTION_BASE||m.productionBaseSha!==PRODUCTION_BASE||m.provider!==legacy.manifest.provider||m.model!==legacy.manifest.model||legacy.json(definition.checkpoints['CP-500'])!==legacy.json([480000,550000])||legacy.json(definition.checkpoints['CP-750'])!==legacy.json([720000,790000])||m.calibration.mode!=='off'||m.calibration.activation!=='pressure'||m.calibration.compilerExecutions!==0||m.calibration.compaction!==false||
  m.calibration.minimumPhaseGrowth!==10000||m.calibration.maximumPhaseShare!==0.4||m.calibration.diagnosticExampleLimit!==8||legacy.json(m.calibration.phases)!==legacy.json(['E01','E02','E03','E04','E05','E06']))S.fail('lhcb02-manifest-invalid');return true;};
const authority={...require('../../../benchmarks/ccv2-lhcb-01/autorunner-authority.json'),benchmarkId:manifest.benchmarkId,
  get contractHash(){return contractHash();},promptHashes:Object.fromEntries(manifest.stages.map(id=>{const f=fs.readdirSync(path.join(BENCH,'prompts')).find(f=>f.startsWith(id+'-'));return [id,S.hash(fs.readFileSync(path.join(BENCH,'prompts',f)))];}))};
const cache=new Map(),base=path.resolve(__dirname,'../ccv2-lhcb');
function loadInternal(name){
  const filename=path.resolve(base,name.endsWith('.cjs')?name:name+'.cjs');
  if(!filename.startsWith(base+path.sep))throw Error('infrastructure-module-escape');
  if(cache.has(filename))return cache.get(filename).exports;
  const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));cache.set(filename,m);
  m.require=request=>{
    const resolved=Module._resolveFilename(request,m);
    // Doctor launches the pinned isolated Node under the unchanged shared
    // blocker. Its exact preload path is part of that blocker's child allowlist.
    if(resolved===path.join(base,'state.cjs'))return filename===path.join(base,'doctor.cjs')?{...S,BENCH:legacy.BENCH}:S;
    if(resolved===path.join(legacy.BENCH,'autorunner-authority.json'))return authority;
    if(resolved===path.join(legacy.BENCH,'fixture/create-fixture.cjs'))return require(path.join(BENCH,'fixture/create-fixture.cjs'));
    if(resolved.startsWith(base+path.sep)&&resolved.endsWith('.cjs'))return loadInternal(path.relative(base,resolved));
    return Module.createRequire(filename)(request);
  };
  m._compile(fs.readFileSync(filename,'utf8'),filename);return m.exports;
}
function load(name){
 if(!['init','doctor','session','agent-transport','session-log','route-observation','arms','autorunner'].includes(name.replace(/\.cjs$/, '')))S.fail('lhcb02-official-disabled');
 const result=loadInternal(name);
 if(name.replace(/\.cjs$/, '')==='doctor')return {...result,doctor(root){const value=result.doctor(root);if(value.certification?.health==='HEALTHY'&&!require('./certification.cjs').coreCompatible(root)){value.certification={health:'UNKNOWN',state:'production-core-incompatible'};value.liveReady=false;}return value;}};
 if(name.replace(/\.cjs$/, '')==='init')return {...result,stageRuntime(root,...args){const value=result.stageRuntime(root,...args);const file=S.inside(root,'state/runtime.json');S.write(file,{...S.read(file),productionBaseSha:S.manifest.baseSha,stagedAtUtc:new Date().toISOString()});return value;}};
 if(name.replace(/\.cjs$/, '')==='arms')return {configure:result.configure};
 if(name.replace(/\.cjs$/, '')==='autorunner'){const protocol={};for(const k of ['timestamp','save','binding','telemetry','wait','agentStatus','memoryReady','durable','sessionArtifacts','discoverBinding'])protocol[k]=result.AutoRunner.prototype[k];return {AutoRunner:{prototype:protocol},authority:result.authority,validateCredentials:result.validateCredentials,assertPreflight:result.assertPreflight,evidence:result.evidence,identity:result.identity,exactPrompt:result.exactPrompt};}
 return result;
}
module.exports={S,load,authority,definition};
