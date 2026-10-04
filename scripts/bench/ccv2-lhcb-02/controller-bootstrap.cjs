'use strict';
const {S,load}=require('./infrastructure.cjs');
const {execFileSync}=require('node:child_process');
const {createRequire}=require('node:module'),{pathToFileURL}=require('node:url');
const fields=['sessionId','taskId','taskInstanceId','engine','profile','provider','model'];
const target=Object.freeze({engine:'muse',profile:'muse-spark-1.3-contributor-opencode',provider:'opencode-go',model:'muse-spark-1.3-contributor'});
const blankEvents=events=>events.length===0||(events.length<=2&&events[0].type==='agent-preset/selected'&&events[0].data.agentPreset==='aih-muse'&&(events.length===1||(events[1].type==='session/end-seed'&&Object.keys(events[1].data).length===0)));
function exact(value,sessionId){
 if(!value||Object.keys(value).sort().join()!==[...fields].sort().join()||value.sessionId!==sessionId||!/^TASK-\d+$/.test(value.taskId)||typeof value.taskInstanceId!=='string'||!value.taskInstanceId||Object.entries(target).some(([k,v])=>value[k]!==v))S.fail('lhcb02-bootstrap-authority-invalid');
 return Object.fromEntries(fields.map(k=>[k,value[k]]));
}
function verify(root,authority,{requireZeroAttempt=true}={}){
 const a=exact(authority,authority.sessionId),workspace=S.inside(root,'workspace'),install=S.inside(root,'nexus-root');
 const binding=S.read(S.inside(install,'data/routing/session-bindings.json')).bindings?.[a.sessionId];
 const agree=x=>x&&x.taskId===a.taskId&&x.taskInstanceId===a.taskInstanceId;
 if(!agree(binding)||binding.sessionId!==a.sessionId||binding.workspace!==workspace||binding.preset!=='aih-muse'||binding.engine!==a.engine||binding.needsRouteCheck!==false||Object.entries(target).some(([k,v])=>binding.preparationAuthority?.[k]!==v))S.fail('lhcb02-bootstrap-binding-mismatch');
 const statePath=require(S.inside(install,'config/Engineering-Profiles.cjs')).routingStatePath(install,binding),route=S.read(statePath);
 if(!agree(route)||route.workspace!==workspace||route.preset!=='aih-muse'||Object.entries(target).some(([k,v])=>route[k]!==v))S.fail('lhcb02-bootstrap-routing-mismatch');
 const tasks=S.read(S.inside(workspace,'.ai-harness/state/tasks.json')).tasks,matches=tasks.filter(agree);
 if(matches.length!==1||matches[0].boundEngine!==a.engine||Object.entries(target).some(([k,v])=>matches[0].controllerPreparationAuthority?.[k]!==v)||(requireZeroAttempt&&matches[0].attempt!==0))S.fail('lhcb02-bootstrap-ledger-mismatch');
 for(const file of ['manifest.json','ccv2-authority.json'])if(!agree(S.read(S.inside(workspace,'.ai-harness/runs/'+a.taskId+'/'+file))))S.fail('lhcb02-bootstrap-task-mismatch');
 const diagnostic=S.fs.readFileSync(S.inside(install,'data/logs/aih-controller.log'),'utf8').split('\n').filter(Boolean).map(JSON.parse).find(x=>x.event==='nexus-session-prepared'&&fields.every(k=>x[k]===a[k])&&['new','reused'].includes(x.status));
 if(!diagnostic)S.fail('lhcb02-bootstrap-diagnostic-missing');
 return a;
}
async function worker(root,sessionId,action){
 if(process.version!==S.manifest.nodeVersion||!/^session-[a-f0-9-]+$/.test(sessionId)||!['create','prepare'].includes(action))S.fail('lhcb02-bootstrap-request-invalid');
 S.ready(root);const install=S.inside(root,'nexus-root'),workspace=S.inside(root,'workspace');
 if(!load('doctor').sourceGuard(S.REPO,install).pass)S.fail('lhcb02-bootstrap-source-drift');
 const runtime=S.read(S.inside(root,'state/runtime.json'));if(runtime.productionBaseSha!==S.manifest.baseSha)S.fail('lhcb02-bootstrap-runtime-drift');
 process.env.DSH_HOME=S.inside(install,'data');process.env.AIH_INSTALL_ROOT=install;process.env.AIH_TOOLCHAIN_ROOT=install;process.env.AIH_PWSH_HOST=S.inside(install,'runtime/pwsh/pwsh');
 delete process.env.DSH_AIH_PROFILE;delete process.env.AIH_ACTIVE_PROFILE;
 const req=createRequire(S.inside(install,'app/package.json')),imp=async name=>import(pathToFileURL(req.resolve(name)).href);
 const {Context}=await imp('@deepseek-ai/cordis'),{SessionStore}=await imp('@deepseek-ai/dsh-session'),{JsonlSessionPersistence}=await imp('@deepseek-ai/dsh-session-persistence-jsonl');
 const ctx=new Context();new SessionStore(ctx);const persistence=new JsonlSessionPersistence(ctx,{root:S.inside(install,'data/sessions')});
 try{
  const exists=(await persistence.list()).some(x=>(x.meta?.id??x.id)===sessionId);
  let session;
  if(exists){const stored=await persistence.load(sessionId);session=ctx.sessions.create(sessionId,{meta:structuredClone(stored.meta),seed:structuredClone(stored.events),seedSource:'persistence'});}
  else{
   session=ctx.sessions.create(sessionId,{meta:{cwd:workspace,agentPreset:'aih-muse'}});
   // Normal persistence is lazy until an event exists. Record the supported
   // content-free preset selection, never a user message or agent turn.
   session.append('agent-preset/selected',{agentPreset:'aih-muse'});
  }
  if(session.header.cwd!==workspace||session.header.agentPreset!=='aih-muse'||!blankEvents(session.events))S.fail('lhcb02-bootstrap-session-invalid');
  await ctx.sessions.flush(session);
  const durable=await persistence.readRaw(sessionId);
  if(!durable||durable.meta.id!==sessionId||durable.meta.cwd!==workspace)S.fail('lhcb02-bootstrap-session-not-durable');
  if(action==='create')return {sessionId};
  ctx.provide('shellEnv',{register(){}});
  const controller=require(S.inside(install,'config/AihController.cjs'));controller.apply(ctx);
  const authority=await controller.prepareSession(ctx,{sessionId,cwd:workspace,preset:'aih-muse',profileId:target.profile});
  if(!blankEvents(session.events)||global.lhcbBootstrapNetwork.attempts()!==0)S.fail('lhcb02-bootstrap-inference-forbidden');
  return verify(root,exact(authority,sessionId));
 }finally{await ctx.fiber.dispose();}
}
function createAdapter(root){
 const install=S.inside(root,'nexus-root');
 function call(action,sessionId){
  const env={...process.env,AIH_INSTALL_ROOT:install,DSH_HOME:S.inside(install,'data'),AIH_TOOLCHAIN_ROOT:install,NODE_OPTIONS:''};
  try{return JSON.parse(execFileSync(S.inside(install,'runtime/node/bin/node'),['--require',S.path.join(__dirname,'bootstrap-network.cjs'),__filename,root,sessionId,action],{env,encoding:'utf8',timeout:120000,maxBuffer:128*1024,stdio:['ignore','pipe','pipe']}));}
  catch(e){const code=String(e.stderr||'').trim();S.fail(/^lhcb-[a-z0-9-]+$/.test(code)?code.slice(5):'lhcb02-bootstrap-failed');}
 }
 return {create:sessionId=>call('create',sessionId),prepare:sessionId=>verify(root,call('prepare',sessionId)),verify:a=>verify(root,a)};
}
if(require.main===module)worker(...process.argv.slice(2)).then(a=>process.stdout.write(JSON.stringify(a))).catch(e=>{process.stderr.write((/^lhcb-[a-z0-9-]+$/.test(e.message)?e.message:'lhcb-bootstrap-failed')+'\n');process.exitCode=1;});
module.exports={createAdapter,verify,exact,target,blankEvents};
