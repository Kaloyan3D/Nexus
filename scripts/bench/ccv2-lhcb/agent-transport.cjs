'use strict';
// Supported installed DSH host API: session.create resumes exact stored ids,
// session.prompt calls agent.followup; session.list reports agent/status;
// HEAD session.export awaits ctx.sessions.flush before reading the artifact.
const S=require('./state.cjs');
const {createRequire}=require('node:module');
const {pathToFileURL}=require('node:url');
const {spawn,execFile}=require('node:child_process');
const authority=require('../../../benchmarks/ccv2-lhcb-01/autorunner-authority.json');
const base='http://127.0.0.1:3080';
function token(pid){try{const row=S.fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ');return row[0]==='Z'?null:row[19];}catch{return null;}}
function listeners(){const out=[];for(const p of ['/proc/net/tcp','/proc/net/tcp6']){const rows=S.fs.readFileSync(p,'utf8').trim().split('\n').slice(1);for(const row of rows){const parts=row.trim().split(/\s+/);if(parts[1].endsWith(':0C08')&&parts[3]==='0A')out.push(parts[9]);}}return out;}
function ownsListener(pid){const sockets=new Set(listeners().map(n=>'socket:['+n+']'));try{return S.fs.readdirSync('/proc/'+pid+'/fd').some(n=>{try{return sockets.has(S.fs.readlinkSync('/proc/'+pid+'/fd/'+n));}catch{return false;}});}catch{return false;}}
function sameProcess(record,install){if(!record||!Number.isSafeInteger(record.pid)||!token(record.pid))return false;try{return record.processToken===token(record.pid)&&S.fs.realpathSync('/proc/'+record.pid+'/exe')===S.inside(install,'runtime/node/bin/node')&&S.fs.readFileSync('/proc/'+record.pid+'/cmdline','utf8').split('\0').includes(S.inside(install,'app/node_modules/@deepseek-ai/dsh/lib/bin.js'));}catch{return false;}}
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
function createTransport(root,env){
  const install=S.inside(root,'nexus-root'),file=S.inside(root,'state/autorunner-runtime.json');let client=null,owned=null;
  async function loadClient(){client||=await createApiClient(install);}
  async function rpc(method,payload,rpcId){await loadClient();if(rpcId)client.nextId=rpcId;let response;try{response=await client.callUnary(method,payload);}catch{S.fail('runner-agent-transport-failed');}if(!response.result.ok)S.fail('runner-agent-request-rejected');return response.result.value;}
  async function rawFlush(id){let response;try{response=await fetch(base+'/api/session.export?sessionId='+encodeURIComponent(id),{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(30000)});}catch{S.fail('runner-agent-flush-failed');}return response.ok;}
  async function list(){const r=await rpc('session.list',{});if(!Array.isArray(r.items))S.fail('runner-status-malformed');return r.items;}
  async function quiet(){const items=await list();if(items.some(x=>typeof x.running!=='boolean'||x.running))S.fail('runner-runtime-busy');for(const item of items)if(await rawFlush(item.sessionId)!==true)S.fail('runner-agent-flush-failed');}
  async function wait(predicate,ms,code){const until=Date.now()+ms;while(!predicate()){if(Date.now()>=until)S.fail(code);await new Promise(resolve=>setTimeout(resolve,100));}}
  async function stop(){
    if(!owned&&S.fs.existsSync(file)){const r=S.read(file);if(r.root!==root||r.contractHash!==authority.contractHash||r.environmentOnly!==true)S.fail('runner-runtime-record-invalid');owned=r;}
    if(!owned){
      if(!listeners().length)return;
      const p=S.inside(install,'data/aih-state.json');if(!S.fs.existsSync(p))S.fail('runner-port-in-use');const state=S.read(p),prior={pid:state.Pid,processToken:token(state.Pid)};
      if(!sameProcess(prior,install)||!ownsListener(prior.pid))S.fail('runner-port-in-use');
      await quiet();await new Promise((resolve,reject)=>execFile(S.inside(install,'bin/aih-stop'),[],{env:{PATH:'/usr/bin:/bin',HOME:root,AIH_INSTALL_ROOT:install},timeout:30000},error=>error?reject(new Error('lhcb-runner-runtime-stop-failed')):resolve()));
      await wait(()=>listeners().length===0,15000,'runner-runtime-stop-timeout');return;
    }
    if(sameProcess(owned,install)){
      if(!ownsListener(owned.pid))S.fail('runner-runtime-listener-mismatch');await quiet();process.kill(owned.pid,'SIGTERM');await wait(()=>!sameProcess(owned,install),15000,'runner-runtime-stop-timeout');
    }else if(token(owned.pid))S.fail('runner-runtime-process-drift');
    if(S.fs.existsSync(file))S.fs.unlinkSync(file);owned=null;
  }
  async function start(){
    if(process.platform!=='linux')S.fail('runner-live-platform-unsupported');S.ready(root);await loadClient();
    if(S.fs.existsSync(file)){
      const r=S.read(file);if(r.root!==root||r.contractHash!==authority.contractHash||r.environmentOnly!==true)S.fail('runner-runtime-record-invalid');
      if(sameProcess(r,install)){if(!ownsListener(r.pid))S.fail('runner-runtime-listener-mismatch');owned=r;return;}
      if(token(r.pid))S.fail('runner-runtime-process-drift');S.fs.unlinkSync(file);
    }
    if(listeners().length)await stop();
    const keys=validateCredentials(env);
    // Required provider/counter keys resolve from inherited environment, which
    // wins in the frozen credentials authority. No store is read or copied here.
    const child=spawn(S.inside(install,'runtime/node/bin/node'),[S.inside(install,'app/node_modules/@deepseek-ai/dsh/lib/bin.js'),'web','--port','3080'],{cwd:S.inside(install,'data'),detached:true,stdio:'ignore',env:{PATH:S.inside(install,'runtime/node/bin')+':/usr/bin:/bin',HOME:root,DSH_HOME:S.inside(install,'data'),AIH_INSTALL_ROOT:install,NEXUS_INSTALL_ROOT:install,...keys}});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(new Error('lhcb-runner-runtime-start-failed')));});child.unref();
    await wait(()=>token(child.pid)!==null,1000,'runner-runtime-start-failed');
    owned={root,contractHash:authority.contractHash,pid:child.pid,processToken:token(child.pid),environmentOnly:true};S.write(file,owned);
    await wait(()=>sameProcess(owned,install)&&ownsListener(owned.pid),60000,'runner-runtime-start-timeout');
    await list();
  }
  async function resume(sessionId){
    // The engine has already checked durable id/cwd/task evidence. Passing that
    // exact id to session.create selects the existing resume path, not a fork.
    const r=await rpc('session.create',{sessionId,cwd:S.inside(root,'workspace'),agentPreset:'aih-muse'});if(r.sessionId!==sessionId)S.fail('runner-session-task-identity-drift');
  }
  return {
    start,stop,resume,create:resume,
    async submit(sessionId,text,rpcId){const r=await rpc('session.prompt',{sessionId,mode:'queue',content:[{type:'text',text}]},rpcId);if(r.accepted!==true||r.command)S.fail('runner-prompt-not-accepted');},
    async status(sessionId){const matches=(await list()).filter(x=>x.sessionId===sessionId);if(matches.length!==1||typeof matches[0].running!=='boolean')S.fail('runner-status-malformed');return {sessionId,cwd:matches[0].cwd,status:matches[0].running?'running':'idle'};},
    flush:rawFlush,
    async close(){if(!owned)return;const items=await list();if(items.every(x=>x.running===false))await stop();},
  };
}
module.exports={validateCredentials,createTransport,createApiClient,sameProcess,ownsListener};
