'use strict';
const assert=require('node:assert/strict'),N=require('../fixture/continuation.cjs');
function grade(dir,ids){
 const probes=[];let sandbox;try{sandbox=require('./sandbox.cjs').create(dir);}catch{return {pass:false,probes:[{id:'continuation-load',pass:false}]};}
 const probe=(id,phase,fn)=>{if(!ids.includes(phase))return;try{fn();probes.push({id,phase,pass:true});}catch{probes.push({id,phase,pass:false});}};
 for(const [phase,name] of N.specs){
  probe('continuation-contract-'+name,phase,()=>{for(const r of N.cases(phase,true)){const actual=sandbox.evaluate(name,r.input);assert.deepEqual(actual.output,r.expected);assert.deepEqual(actual.input,r.input);}});
  probe('continuation-execution-'+name,phase,()=>{for(const r of N.executions(phase,true))assert.deepEqual(sandbox.run(N.scenarioCode(r.input)),r.expected);});
 }return {pass:probes.every(p=>p.pass),probes};
}
module.exports={grade};
