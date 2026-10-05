'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const fixture=require('../fixture/create-fixture.cjs');
function grade(dir,ids){
 if(!Array.isArray(ids)||!ids.length||ids.some(id=>!fixture.modules[id])||new Set(ids).size!==ids.length)throw Error('grader-phase-invalid');
 let sandbox;try{sandbox=require('./sandbox.cjs').create(dir);}catch{return ids.map(phase=>({phase,pass:false,cases:0}));}
 const rows=[];
 for(const phase of ids){let failures=0;const cases=fixture.cases(phase);
  // Expected values are owned by the host fixture contract, never candidate stdout.
  const file=path.join(dir,'evidence',phase,'cases.jsonl');
  try{assert.equal(fs.readFileSync(file,'utf8'),fixture.phaseFiles(phase)['evidence/'+phase+'/cases.jsonl']);}catch{failures++;}
  for(const row of cases){try{const result=sandbox.evaluate(fixture.modules[phase],row.input);assert.deepEqual(result.output,row.expected);assert.deepEqual(result.input,row.input);}catch{failures++;}}
  const journey=require('../fixture/journeys.cjs'),name=fixture.modules[phase];for(const input of journey.inputs(phase)){try{const result=sandbox.evaluate(name+'-journey',input);assert.deepEqual(result.output,journey.expected(input));assert.deepEqual(result.input,input);}catch{failures++;}}
  const extension=require('../fixture/extensions.cjs');if(extension.specs.some(s=>s[0]===phase))for(const row of extension.integrations(phase)){try{const result=require('./extension-probes.cjs').integrate(sandbox,name,row.input);assert.deepEqual(result.output,row.expected);assert.deepEqual(result.input,row.input);}catch{failures++;}}
  const workflow=require('../fixture/workflows.cjs');if(workflow.specs.some(s=>s[0]===phase))for(const row of workflow.executions(phase)){try{assert.deepEqual(sandbox.run(workflow.scenarioCode(row.input)),row.expected);}catch{failures++;}}
  rows.push({phase,pass:failures===0,cases:cases.length});
 }
 const holdout=require('./probes.cjs').grade(dir,ids);rows.push({phase:'holdout',pass:holdout.pass,probes:holdout.probes});return rows;
}
if(require.main===module)process.stdout.write(JSON.stringify(grade(path.resolve(process.argv[2]),JSON.parse(process.argv[3])))+'\n');
module.exports={grade};
