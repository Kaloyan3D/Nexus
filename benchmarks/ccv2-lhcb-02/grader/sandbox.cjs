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
 // Clone supported JSON caller values inside the candidate realm. No host
 // function, value or exception crosses this boundary. Graph/collection support
 // also permits ordinary internal cloning; ownership transfer is not a JSON API.
 new vm.Script(`(()=>{
 const MapCtor=Map,SetCtor=Set,DateCtor=Date,RegExpCtor=RegExp,ErrorCtor=Error;
 const keys=Object.keys.bind(Object),define=Object.defineProperty.bind(Object),isArray=Array.isArray.bind(Array),isView=ArrayBuffer.isView.bind(ArrayBuffer);
 const arrayBufferSlice=ArrayBuffer.prototype.slice,ArrayBufferCtor=ArrayBuffer,DataViewCtor=DataView;
 const typed=[Int8Array,Uint8Array,Uint8ClampedArray,Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array,BigInt64Array,BigUint64Array];
 function invalid(){const e=new ErrorCtor('Value cannot be cloned in the JSON caller contract');e.name='DataCloneError';throw e;}
 function clone(value,options){
  if(options?.transfer?.length)invalid();const seen=new MapCtor();
  function copy(v){
   if(typeof v==='function'||typeof v==='symbol')invalid();if(v===null||typeof v!=='object')return v;if(seen.has(v))return seen.get(v);
   let out;
   if(v instanceof DateCtor){out=new DateCtor(v.getTime());seen.set(v,out);return out;}
   if(v instanceof RegExpCtor){out=new RegExpCtor(v.source,v.flags);seen.set(v,out);return out;}
   if(v instanceof ArrayBufferCtor){out=arrayBufferSlice.call(v,0);seen.set(v,out);return out;}
   if(isView(v)){const buffer=copy(v.buffer);out=v instanceof DataViewCtor?new DataViewCtor(buffer,v.byteOffset,v.byteLength):new (typed.find(T=>v instanceof T))(buffer,v.byteOffset,v.length);seen.set(v,out);return out;}
   if(v instanceof MapCtor){out=new MapCtor();seen.set(v,out);for(const [k,item] of v)out.set(copy(k),copy(item));return out;}
   if(v instanceof SetCtor){out=new SetCtor();seen.set(v,out);for(const item of v)out.add(copy(item));return out;}
   out=isArray(v)?new Array(v.length):{};seen.set(v,out);for(const key of keys(v))define(out,key,{value:copy(v[key]),enumerable:true,writable:true,configurable:true});return out;
  }return copy(value);
 }
 define(globalThis,'structuredClone',{value:clone,writable:true,configurable:true});
 })();`).runInContext(context,{timeout:1000});
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
