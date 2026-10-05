'use strict';
const assert=require('node:assert/strict'),P=require('../fixture/canonical-statements.cjs');
function grade(dir,ids){if(!ids.includes('E46'))return {pass:true,probes:[]};let sandbox;try{sandbox=require('./sandbox.cjs').create(dir);}catch{return {pass:false,probes:[{id:'statement-page-contract',phase:'E46',pass:false}]};}
 const probes=[];const probe=(id,fn)=>{try{fn();probes.push({id,phase:'E46',pass:true});}catch{probes.push({id,phase:'E46',pass:false});}};
 probe('statement-page-contract',()=>{for(const row of P.cases('E46',true)){const result=sandbox.evaluate('canonical-statements',row.input);assert.deepEqual(result.output,row.expected);assert.deepEqual(result.input,row.input);}});
 probe('statement-page-execution',()=>{for(const row of P.executions('E46',true))assert.deepEqual(sandbox.run(P.scenarioCode(row.input)),row.expected);});
 return {pass:probes.every(p=>p.pass),probes};}
module.exports={grade};
