'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const POLICY=Object.freeze({revision:1,directory:'scratch',environment:'LHCB_SCRATCH',persistentSource:'src/',reset:'before-and-after-every-phase',snapshot:'excluded-and-empty',links:'forbidden'});
const fail=code=>{throw Error('lhcb02-scratch-'+code);};
function directory(root){
 if(typeof root!=='string'||!path.isAbsolute(root)||root.split(/[\\/]/).includes('..')||root.includes('\0'))fail('root');
 const absolute=path.resolve(root);if(fs.realpathSync(absolute)!==absolute)fail('root-link');
 const dir=path.join(absolute,POLICY.directory);let stat;try{stat=fs.lstatSync(dir);}catch(e){if(e.code!=='ENOENT')throw e;}
 if(stat&&(stat.isSymbolicLink()||!stat.isDirectory()))fail('directory');
 if(!stat)fs.mkdirSync(dir,{mode:0o700});return dir;
}
function resolve(root,relative){if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).some(p=>!p||p==='.'||p==='..')||relative.includes('\0'))fail('escape');const dir=directory(root),file=path.join(dir,relative);let at=dir;for(const part of relative.split('/')){at=path.join(at,part);try{if(fs.lstatSync(at).isSymbolicLink())fail('link');}catch(e){if(e.code!=='ENOENT')throw e;}}return file;}
function inventory(root){const dir=directory(root),files={};function walk(at,prefix){for(const e of fs.readdirSync(at,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))){const file=path.join(at,e.name),rel=prefix+e.name,stat=fs.lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory())fail('unsupported-file');if(stat.isDirectory())walk(file,rel+'/');else{if(stat.nlink!==1)fail('hardlink');files[rel]={sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),bytes:stat.size};}}}walk(dir,'');return files;}
function reset(root){const files=inventory(root),dir=directory(root);for(const e of fs.readdirSync(dir))fs.rmSync(path.join(dir,e),{recursive:true,force:false});if(fs.readdirSync(dir).length)fail('reset');return {policyRevision:POLICY.revision,fileCount:Object.keys(files).length,files,emptyAfterReset:true};}
function assertEmpty(root){inventory(root);if(fs.readdirSync(directory(root)).length)fail('nonempty-at-snapshot');}
function assertCandidate(root){const src=path.join(root,'workspace/src');if(!fs.existsSync(src))return;function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name),stat=fs.lstatSync(p);if(stat.isSymbolicLink()||!stat.isDirectory()&&!stat.isFile())fail('candidate-alias');if(stat.isDirectory())walk(p);else if(stat.nlink!==1)fail('candidate-hardlink');}}walk(src);}
module.exports={POLICY,directory,resolve,inventory,reset,assertEmpty,assertCandidate};
