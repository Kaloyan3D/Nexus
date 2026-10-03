'use strict';
// Inherited by every Node child during grading. Any attempted network access fails.
let attempts=0;
const deny=()=>{attempts++;throw new Error('lhcb-network-forbidden');};
for(const [mod,keys] of [['node:net',['connect','createConnection']],['node:tls',['connect']],['node:http',['request','get']],['node:https',['request','get']],['node:dgram',['createSocket']],['node:dns',['lookup','resolve','resolve4','resolve6']]])for(const k of keys)require(mod)[k]=deny;
global.fetch=deny;global.WebSocket=class{constructor(){deny();}};
process.on('exit',()=>{if(attempts)process.exitCode=98;});
const cp=require('node:child_process'),path=require('node:path');
function allowed(command,args){
  if(path.resolve(String(command))===path.resolve(process.execPath))return true;
  // An isolated copy of this exact Node is allowed only with this blocker explicitly preloaded.
  if(path.isAbsolute(String(command))&&args?.[0]==='--require'&&args[1]===__filename){
    try{const fs=require('node:fs'),crypto=require('node:crypto');const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');if(hash(command)===hash(process.execPath))return true;}catch{}
  }
  if(command==='git'){
    if(args?.[0]==='-C'){if(!path.isAbsolute(args[1]))return false;args=args.slice(2);}
    const permitted=['status','branch','rev-parse','merge-base','ls-tree','ls-files','show','hash-object','cat-file','rev-list','init','add','write-tree','config','commit-tree','update-ref','clone'];
    if(!permitted.includes(args?.[0]))return false;
    if(args[0]==='config'&&args.length!==2)return false;
    if(args[0]==='clone')return args.includes('--shared')&&args.slice(-2).every(p=>path.isAbsolute(p));
    return !args.some(x=>/^https?:|^ssh:|^git@/.test(String(x)));
  }
  return false;
}
for(const name of ['spawn','spawnSync','execFile','execFileSync']){const original=cp[name];cp[name]=function(command,args,options,...rest){if(!allowed(command,args))return deny();return original.call(this,command,args,options,...rest);};}
for(const name of ['exec','execSync','fork'])cp[name]=deny;
Object.defineProperty(global,'lhcbOfflineAudit',{value:{attempts:()=>attempts,policy:'Node network APIs and network-capable external commands blocked'}});
require('node:net').Socket.prototype.connect=deny;
require('node:net').Server.prototype.listen=deny;
require('node:http2').connect=deny;
for(const key of ['lookup','resolve','resolve4','resolve6','reverse'])if(require('node:dns').promises[key])require('node:dns').promises[key]=deny;
