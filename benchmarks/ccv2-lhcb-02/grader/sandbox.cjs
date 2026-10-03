'use strict';
// Candidate modules never execute in the grading host or receive host objects.
// This restricts the fixture's module contract; it is not an OS sandbox for DSH tools.
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {stripTypeScriptTypes}=require('node:module');
function create(dir){
 const base=path.resolve(dir,'src');const files=fs.readdirSync(base).filter(f=>f.endsWith('.ts')).sort();
 const wrappers=[];
 for(const name of files){const file=path.join(base,name);if(fs.lstatSync(file).isSymbolicLink())throw Error('grader-source-link');
  const code=stripTypeScriptTypes(fs.readFileSync(file,'utf8'),{mode:'strip'});
  wrappers.push(JSON.stringify(name)+':function(module,exports,require){"use strict";\n'+code+'\n}');
 }
 const context=vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}});
 // Compile candidate factories outside the trusted closure. They cannot see its
 // lexical bindings, even though both execute in the same restricted realm.
 new vm.Script('globalThis.__candidateFactories={'+wrappers.join(',')+'};').runInContext(context,{timeout:1000});
 new vm.Script(`(()=>{
 const factories=globalThis.__candidateFactories;delete globalThis.__candidateFactories;
 const __Error=Error;
 const __jsonStringify=JSON.stringify.bind(JSON),__create=Object.create.bind(Object),__descriptor=Object.getOwnPropertyDescriptor.bind(Object),__names=Object.getOwnPropertyNames.bind(Object),__array=Array.isArray.bind(Array),__setPrototype=Object.setPrototypeOf.bind(Object);
 function __snapshot(value,parents=[]){
   if(value===null||(typeof value==='string'||typeof value==='boolean'||typeof value==='number'))return value;
   if(typeof value!=='object'||parents.length>64)throw new __Error('grader-output-not-json');
   for(let i=0;i<parents.length;i++)if(parents[i]===value)throw new __Error('grader-output-not-json');
   const next=__array(value)?__setPrototype([],null):__create(null);
   const ancestry=__setPrototype([],null);for(let i=0;i<parents.length;i++)ancestry[i]=parents[i];ancestry[parents.length]=value;
   for(const key of __names(value)){
     if(key==='toJSON')throw new __Error('grader-output-not-json');
     const d=__descriptor(value,key);if(!d||!('value' in d))throw new __Error('grader-output-not-json');
     if(__array(value)&&key==='length')continue;
     next[key]=__snapshot(d.value,ancestry);
   }return next;
 }
 const __encode=value=>__jsonStringify(__snapshot(value));
 const __load=(()=>{
   const cache=Object.create(null);
   return function load(name){
     if(!Object.prototype.hasOwnProperty.call(factories,name))throw Object.assign(new Error('module unavailable'),{code:'MODULE_NOT_FOUND'});
     if(cache[name])return cache[name].exports;
     const module={exports:{}};cache[name]=module;
     factories[name](module,module.exports,function require(target){
       if(typeof target!=='string'||!/^\\.\\/[a-z][a-z0-9-]*\\.ts$/.test(target))throw new Error('grader-import-forbidden');
       return load(target.slice(2));
     });return module.exports;
   };
 })();
 Object.defineProperty(globalThis,'__gradeRun',{value:callback=>__encode(callback(__load)),writable:false,configurable:false});
 })();
 `).runInContext(context,{timeout:1000});
 function run(expression){const json=new vm.Script('__gradeRun((__load)=>{'+expression+'})').runInContext(context,{timeout:1000});return JSON.parse(json);}
 return {run,evaluate(name,input){return run(`const input=JSON.parse(${JSON.stringify(JSON.stringify(input))});const output=__load(${JSON.stringify(name+'.ts')}).evaluate(input);return {output,input};`);}};
}
module.exports={create};
