'use strict';
const assert=require('node:assert/strict'),W=require('../fixture/workflows.cjs');
function grade(dir,ids){const probes=[];let sandbox;try{sandbox=require('./sandbox.cjs').create(dir);}catch{return {pass:false,probes:[{id:'workflow-load',pass:false}]};}
 const probe=(id,phase,fn)=>{if(!ids.includes(phase))return;try{fn();probes.push({id,phase,pass:true});}catch{probes.push({id,phase,pass:false});}};
 for(const [phase,name] of W.specs){
  probe('workflow-contract-'+name,phase,()=>{for(const row of W.cases(phase,true)){const result=sandbox.evaluate(name,row.input);assert.deepEqual(result.output,row.expected);assert.deepEqual(result.input,row.input);}});
  probe('workflow-execution-'+name,phase,()=>{for(const row of W.executions(phase,true))assert.deepEqual(sandbox.run(W.scenarioCode(row.input)),row.expected);});
 }
 return {pass:probes.every(p=>p.pass),probes};
}
module.exports={grade};
