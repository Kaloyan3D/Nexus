'use strict';
// Supported installed DSH host API: session.create resumes exact stored ids,
// session.prompt calls agent.followup; session.list reports agent/status;
// HEAD session.export awaits ctx.sessions.flush before reading the artifact.
const S=require('./state.cjs');
const {createRequire}=require('node:module');
const {pathToFileURL}=require('node:url');
const {spawn}=require('node:child_process');
const authority=require('../../../benchmarks/ccv2-lhcb-01/autorunner-authority.json');
const base='http://127.0.0.1:3080';
function token(pid){try{const row=S.fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ');return row[0]==='Z'?null:row[19];}catch{return null;}}
function listeners(){const out=[];for(const p of ['/proc/net/tcp','/proc/net/tcp6']){const rows=S.fs.readFileSync(p,'utf8').trim().split('\n').slice(1);for(const row of rows){const parts=row.trim().split(/\s+/);if(parts[1].endsWith(':0C08')&&parts[3]==='0A')out.push(parts[9]);}}return out;}
function ownsListener(pid){const sockets=listeners().map(n=>'socket:['+n+']');try{const descriptors=S.fs.readdirSync('/proc/'+pid+'/fd').map(n=>{try{return S.fs.readlinkSync('/proc/'+pid+'/fd/'+n);}catch{return null;}});return sockets.length>0&&sockets.every(n=>descriptors.includes(n));}catch{return false;}}
function sameProcess(record,install){if(!record||!Number.isSafeInteger(record.pid)||!token(record.pid))return false;try{const root=S.path.dirname(install),env=Object.fromEntries(S.fs.readFileSync('/proc/'+record.pid+'/environ','utf8').split('\0').map(x=>{const at=x.indexOf('=');return [x.slice(0,at),x.slice(at+1)];}));return record.processToken===token(record.pid)&&S.fs.realpathSync('/proc/'+record.pid+'/exe')===S.inside(install,'runtime/node/bin/node')&&S.fs.realpathSync('/proc/'+record.pid+'/cwd')===S.inside(install,'data')&&S.fs.readFileSync('/proc/'+record.pid+'/cmdline','utf8').split('\0')[1]===S.inside(install,'app/node_modules/@deepseek-ai/dsh/lib/bin.js')&&env.DSH_HOME===S.inside(install,'data')&&env.AIH_INSTALL_ROOT===install&&env.NEXUS_INSTALL_ROOT===install&&env.HOME===root;}catch{return false;}}
function rpcFailure(method,error){
  let code=/^lhcb-runner-rpc-[a-z0-9-]+$/.test(error?.message)?error.message.slice('lhcb-runner-rpc-'.length):error?.name==='ZodError'||error?.name==='SyntaxError'||error?.message?.startsWith('rpcId mismatch')?'schema-rejected':error?.name==='TypeError'||['ECONNREFUSED','ECONNRESET','ETIMEDOUT'].includes(error?.cause?.code)?'endpoint-unavailable':'transport-failed';
  S.fail((method==='session.create'?'runner-session-resume-rpc-':'runner-rpc-')+code);
}
function validateCredentials(env){
  const out={};for(const name of ['OPENCODE_API_KEY','MODEL_API_KEY']){const value=env[name];if(typeof value!=='string'||/[\x00-\x1f\x7f]/.test(value)||!value.trim()||/[^\x20-\x7e]/.test(value))S.fail('runner-environment-credentials-invalid');out[name]=value.trim();}return out;
}
async function createApiClient(install,fetchImpl=globalThis.fetch){
  const req=createRequire(S.inside(install,'app/package.json'));
  const {AbstractApiClient}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-host-apiproxy')).href);
  class LocalClient extends AbstractApiClient{
    resolveBase(){return base;}
    doFetch(url,init){return fetchImpl(url,{...init,redirect:'error'});}
    mintRpcId(){const id=this.nextId;if(id){this.nextId=null;return id;}return super.mintRpcId();}
  }
  return new LocalClient(30000);
}
function createTransport(root,env,options={}){
  const ops={token,listeners,sameProcess,ownsListener,spawn,kill:(pid,signal)=>process.kill(pid,signal),now:Date.now,pause:ms=>new Promise(resolve=>setTimeout(resolve,ms)),fetch:globalThis.fetch,apiClient:createApiClient,...options};
  const install=S.inside(root,'nexus-root'),file=S.inside(root,'state/autorunner-runtime.json');let client=null,owned=null,startedHere=false,submitted=false;
  async function loadClient(){client||=await ops.apiClient(install,async(url,init)=>{const r=await ops.fetch(url,init);if(!r.ok)S.fail(r.status===404||r.status===503?'runner-rpc-endpoint-unavailable':'runner-rpc-http-'+r.status);return r;});}
  async function rpc(method,payload,rpcId){if(options.readOnlyProbe&&!['session.list','session.create'].includes(method))S.fail('runner-read-only-probe-method-forbidden');await loadClient();if(rpcId)client.nextId=rpcId;let response;try{response=await client.callUnary(method,payload);}catch(e){rpcFailure(method,e);}if(!response.result.ok)S.fail(method==='session.create'?'runner-session-resume-rpc-request-rejected':'runner-rpc-request-rejected');return response.result.value;}
  async function rawFlush(id){let response;try{response=await ops.fetch(base+'/api/session.export?sessionId='+encodeURIComponent(id),{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(30000)});}catch{S.fail('runner-session-export-unavailable');}if(!response.ok)S.fail('runner-session-export-http-'+response.status);return true;}
  async function list(){const r=await rpc('session.list',{});if(!Array.isArray(r.items))S.fail('runner-status-malformed');return r.items;}
  async function quiet(){const items=await list();if(items.some(x=>typeof x.running!=='boolean'||x.running))S.fail('runner-runtime-busy');for(const item of items)if(await rawFlush(item.sessionId)!==true)S.fail('runner-agent-flush-failed');}
  async function wait(predicate,ms,code){const until=ops.now()+ms;while(!await predicate()){if(ops.now()>=until)S.fail(code);await ops.pause(100);}}
  async function stop({preSubmitFailure=false}={}){
    if(!owned&&S.fs.existsSync(file)){const r=S.read(file);if(r.root!==root||r.contractHash!==authority.contractHash||r.environmentOnly!==true)S.fail('runner-runtime-record-invalid');owned=r;}
    if(!owned){
      if(!ops.listeners().length)return;
      const p=S.inside(install,'data/aih-state.json');if(!S.fs.existsSync(p))S.fail('runner-port-in-use');const state=S.read(p),prior={pid:state.Pid,processToken:token(state.Pid)};
      if(!ops.sameProcess(prior,install)||!ops.ownsListener(prior.pid))S.fail('runner-port-in-use');
      await quiet();if(!ops.sameProcess(prior,install))S.fail('runner-runtime-process-drift');if(!ops.ownsListener(prior.pid))S.fail('runner-runtime-listener-mismatch');ops.kill(prior.pid,'SIGTERM');
      await wait(()=>ops.token(prior.pid)!==prior.processToken,15000,'runner-runtime-stop-timeout');return;
    }
    if(owned.root!==root||owned.contractHash!==authority.contractHash||owned.environmentOnly!==true)S.fail('runner-runtime-record-invalid');
    if(ops.sameProcess(owned,install)){
      if(ops.listeners().length&&!ops.ownsListener(owned.pid))S.fail('runner-runtime-listener-mismatch');
      if(!preSubmitFailure){if(!ops.ownsListener(owned.pid))S.fail('runner-runtime-listener-mismatch');await quiet();}
      // Recheck ownership after the RPC/flush await; never signal a reused PID.
      if(!ops.sameProcess(owned,install))S.fail('runner-runtime-process-drift');if(ops.listeners().length&&!ops.ownsListener(owned.pid))S.fail('runner-runtime-listener-mismatch');
      ops.kill(owned.pid,'SIGTERM');await wait(()=>ops.token(owned.pid)!==owned.processToken,15000,'runner-runtime-stop-timeout');
    }else if(ops.token(owned.pid))S.fail('runner-runtime-process-drift');
    if(S.fs.existsSync(file))S.fs.unlinkSync(file);owned=null;
  }
  async function start(){
    if(process.platform!=='linux')S.fail('runner-live-platform-unsupported');S.ready(root);await loadClient();
    if(S.fs.existsSync(file)){
      const r=S.read(file);if(r.root!==root||r.contractHash!==authority.contractHash||r.environmentOnly!==true)S.fail('runner-runtime-record-invalid');
      if(options.readOnlyProbe&&r.readOnlyProbe!==true)S.fail('runner-read-only-probe-runtime-unprotected');
      if(ops.sameProcess(r,install)){if(!ops.ownsListener(r.pid))S.fail('runner-runtime-listener-mismatch');owned=r;await endpointReady();return;}
      if(ops.token(r.pid))S.fail('runner-runtime-process-drift');S.fs.unlinkSync(file);
    }
    if(ops.listeners().length)await stop();
    const keys=validateCredentials(env);
    // Required provider/counter keys resolve from inherited environment, which
    // wins in the frozen credentials authority. No store is read or copied here.
    const probeEnv=options.readOnlyProbe?{NODE_OPTIONS:'--require='+S.path.join(__dirname,'read-only-network.cjs'),LHCB_READ_ONLY_AUDIT_FILE:S.inside(root,'state/autorunner-probe-network.json')}:{};
    const observerEnv=options.readOnlyProbe?{}:require('./provider-observability-stage.cjs').stage(S,root);
    const child=ops.spawn(S.inside(install,'runtime/node/bin/node'),[S.inside(install,'app/node_modules/@deepseek-ai/dsh/lib/bin.js'),'web','--no-open','--port','3080'],{cwd:S.inside(install,'data'),detached:true,stdio:['ignore','pipe','pipe'],env:{PATH:S.inside(install,'runtime/node/bin')+':/usr/bin:/bin',HOME:root,DSH_HOME:S.inside(install,'data'),AIH_INSTALL_ROOT:install,...keys,NEXUS_INSTALL_ROOT:install,...observerEnv,...probeEnv}});
    const startup={stdoutBytes:0,stderrBytes:0};for(const name of ['stdout','stderr']){child[name]?.on('data',bytes=>{startup[name+'Bytes']+=bytes.length;startup[name+'Hash']=S.hash((startup[name+'Hash']||'')+S.hash(bytes));});child[name]?.unref?.();}
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(new Error('lhcb-runner-runtime-start-failed')));});child.unref();
    await wait(()=>ops.token(child.pid)!==null,1000,'runner-runtime-start-failed');
    owned={root,contractHash:authority.contractHash,pid:child.pid,processToken:ops.token(child.pid),environmentOnly:true,readOnlyProbe:options.readOnlyProbe===true,startup};startedHere=true;S.write(file,owned);
    try{await wait(()=>{if(!ops.token(owned.pid))S.fail('runner-runtime-start-failed');return ops.sameProcess(owned,install)&&ops.ownsListener(owned.pid);},options.startTimeoutMs??60000,'runner-runtime-start-timeout');await endpointReady();}catch(e){owned.failureCode=/^lhcb-[a-z0-9-]+$/.test(e.message)?e.message:'lhcb-runner-runtime-start-failed';S.write(file,owned);throw e;}
    S.write(file,owned);
  }
  async function endpointReady(){await wait(async()=>{if(!ops.sameProcess(owned,install))S.fail('runner-runtime-process-drift');if(!ops.ownsListener(owned.pid))S.fail('runner-runtime-listener-mismatch');try{await list();return true;}catch(e){if(e.message!=='lhcb-runner-rpc-endpoint-unavailable')throw e;return false;}},options.rpcReadyTimeoutMs??30000,'runner-rpc-endpoint-unavailable');}
  async function resume(sessionId){
    // The engine has already checked durable id/cwd/task evidence. Passing that
    // exact id to session.create selects the existing resume path, not a fork.
    if(options.readOnlyProbe&&require('./session.cjs').binding(root).sessionId!==sessionId)S.fail('runner-session-task-identity-drift');
    const r=await rpc('session.create',{sessionId,cwd:S.inside(root,'workspace'),agentPreset:'aih-muse'});if(r.sessionId!==sessionId)S.fail('runner-session-task-identity-drift');
  }
  return {
    start,stop,resume,create:resume,
    async submit(sessionId,text,rpcId){if(options.readOnlyProbe)S.fail('runner-read-only-probe-method-forbidden');require('./provider-observability-stage.cjs').phaseContext(S,root,sessionId,rpcId);submitted=true;const r=await rpc('session.prompt',{sessionId,mode:'queue',content:[{type:'text',text}]},rpcId);if(r.accepted!==true||r.command)S.fail('runner-prompt-not-accepted');},
    async status(sessionId){const matches=(await list()).filter(x=>x.sessionId===sessionId);if(matches.length!==1||typeof matches[0].running!=='boolean')S.fail('runner-status-malformed');return {sessionId,cwd:matches[0].cwd,status:matches[0].running?'running':'idle'};},
    flush:rawFlush,
    async close(){
      if(!owned)return;
      if(!ops.sameProcess(owned,install)){if(ops.token(owned.pid))S.fail('runner-runtime-process-drift');return stop({preSubmitFailure:true});}
      if(ops.listeners().length&&!ops.ownsListener(owned.pid))S.fail('runner-runtime-listener-mismatch');
      if(startedHere&&!submitted){try{await quiet();}catch(e){if(e.message==='lhcb-runner-runtime-busy'||!/^lhcb-runner-(rpc-|session-export-)/.test(e.message))throw e;}return stop({preSubmitFailure:true});}
      const items=await list();if(items.every(x=>x.running===false))await stop();else S.fail('runner-runtime-busy');
    },
  };
}
module.exports={validateCredentials,createTransport,createApiClient,sameProcess,ownsListener,rpcFailure};
