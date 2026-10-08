'use strict';
// Separate host evidence; these results do not participate in any grade gate.
const assert=require('node:assert/strict'),F=require('../fixture/final.cjs');
function integrated(dir){
 let sandbox;try{sandbox=require('./sandbox.cjs').create(dir);}catch(error){return {available:false,error:{name:error.name,code:error.code??null},public:[],hidden:[],smoke:[]};}
 function evaluate(row,smoke=false){let result=null,error=null;
  try{result=sandbox.evaluate('application',row.input);if(smoke){assert.equal(result.output.status,row.expected.status);assert.equal(Array.isArray(result.output.history)&&result.output.history.length>0,row.expected.hasCommit);}else assert.deepEqual(result.output,row.expected);assert.deepEqual(result.input,row.input);}
  catch(e){error={name:e.name,code:e.code??null};}
  // Fixture caller data and JSON outputs, never candidate source or exception
  // message/stack (which could echo source). A failed evaluation is unavailable,
  // rather than an invented null output. Loaded code receives no host objects.
  return {caseId:row.caseId,pass:error===null,input:row.input,expected:row.expected,actual:result?.output??null,inputAfter:result?.input??null,actualAvailable:result!==null,error};
 }
 return {available:true,public:F.cases().map(r=>evaluate(r)),hidden:F.cases(true).map(r=>evaluate(r)),smoke:F.publicCases().map(r=>evaluate(r,true))};
}
module.exports={integrated};
