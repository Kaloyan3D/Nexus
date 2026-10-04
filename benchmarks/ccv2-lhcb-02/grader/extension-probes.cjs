'use strict';
const assert=require('node:assert/strict'),E=require('../fixture/extensions.cjs');
function integrate(sandbox,name,input){return sandbox.run(`const input=JSON.parse(${JSON.stringify(JSON.stringify(input))});const output=__load(${JSON.stringify(name+'.ts')}).integrate(input);return {output,input};`);}
function grade(dir,ids){const probes=[];let sandbox;try{sandbox=require('./sandbox.cjs').create(dir);}catch{return {pass:false,probes:[{id:'extension-load',pass:false}]};}
 const probe=(id,phase,fn)=>{if(!ids.includes(phase))return;try{fn();probes.push({id,phase,pass:true});}catch{probes.push({id,phase,pass:false});}};
 for(const [phase,name] of E.specs){
  probe('extension-contract-'+name,phase,()=>{for(const row of E.cases(phase,true)){const result=sandbox.evaluate(name,row.input);assert.deepEqual(result.output,row.expected);assert.deepEqual(result.input,row.input);}});
  probe('extension-integration-'+name,phase,()=>{for(const row of E.integrations(phase,true)){const result=integrate(sandbox,name,row.input);assert.deepEqual(result.output,row.expected);assert.deepEqual(result.input,row.input);}});
 }
 return {pass:probes.every(p=>p.pass),probes};
}
module.exports={grade,integrate};
