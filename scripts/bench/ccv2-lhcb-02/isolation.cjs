'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),{EventEmitter}=require('node:events');
function spawnIsolated(command,args,options){
 const install=path.dirname(options.cwd),root=path.dirname(install),workspace=path.join(root,'workspace');
 const scratch=require('./scratch.cjs').directory(root);
 const mounts=['--unshare-user','--unshare-pid','--die-with-parent','--ro-bind','/usr','/usr','--ro-bind','/etc','/etc','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--symlink','usr/lib','/lib','--symlink','usr/lib','/lib64','--symlink','usr/bin','/bin','--symlink','usr/bin','/sbin','--ro-bind',install,install,'--bind',options.cwd,options.cwd,'--bind',path.join(install,'logs'),path.join(install,'logs'),'--bind',workspace,workspace,'--bind',scratch,scratch];
 const child=cp.spawn('bwrap',[...mounts,'--chdir',options.cwd,'--info-fd','3',command,...args],{...options,env:{...options.env,LHCB_SCRATCH:scratch},stdio:['ignore','pipe','pipe','pipe']});
 const result=new EventEmitter();result.stdout=child.stdout;result.stderr=child.stderr;result.unref=()=>child.unref();let pending='',finished=false;
 child.once('error',e=>result.emit('error',e));child.once('exit',(code,signal)=>{if(!finished)result.emit('error',Error('sandbox-start-failed'));result.emit('exit',code,signal);});
 child.stdio[3].on('data',async bytes=>{pending+=bytes;let info;try{info=JSON.parse(pending);}catch{return;}
  const until=Date.now()+5000;while(Date.now()<until){
   let ids=[];try{ids=fs.readFileSync('/proc/'+info['child-pid']+'/task/'+info['child-pid']+'/children','utf8').trim().split(/\s+/);}catch{}
   for(const id of ids)try{if(fs.realpathSync('/proc/'+id+'/exe')===command){result.pid=Number(id);finished=true;result.emit('spawn');return;}}catch{}
   await new Promise(r=>setTimeout(r,10));
  }if(!finished){child.kill('SIGKILL');result.emit('error',Error('sandbox-node-not-found'));}
 });return result;
}
module.exports={spawnIsolated};
