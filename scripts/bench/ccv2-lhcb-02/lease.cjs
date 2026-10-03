'use strict';
const {S}=require('./infrastructure.cjs');
function processToken(pid){try{return S.fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ')[19];}catch{return null;}}
function acquire(file,root,options={}){
 S.noLinks(file);const token=options.processToken||processToken;
 if(S.fs.existsSync(file)){
  const prior=S.read(file);
  if(prior.root!==root||prior.contractHash!==S.contractHash()||!Number.isSafeInteger(prior.pid)||prior.pid<=0||typeof prior.processToken!=='string'||!/^\d+$/.test(prior.processToken)||typeof prior.leaseId!=='string')S.fail('runner-lock-invalid');
  const current=token(prior.pid);if(current===prior.processToken)S.fail('runner-busy');if(current)S.fail('runner-lock-ambiguous');
  if(S.json(S.read(file))!==S.json(prior))S.fail('runner-lock-ambiguous');S.fs.unlinkSync(file);
 }
 const own={root,contractHash:S.contractHash(),pid:process.pid,processToken:processToken(process.pid),leaseId:S.crypto.randomUUID()};
 if(!own.processToken)S.fail('runner-lock-process-unavailable');
 let fd;try{fd=S.fs.openSync(file,'wx',0o600);}catch(e){if(e.code==='EEXIST')S.fail('runner-busy');throw e;}
 try{S.fs.writeFileSync(fd,S.json(own));}finally{S.fs.closeSync(fd);}
 return ()=>{if(!S.fs.existsSync(file)||S.json(S.read(file))!==S.json(own))S.fail('runner-lock-ownership-lost');S.fs.unlinkSync(file);};
}
module.exports={acquire,processToken};
