'use strict';
const {S,definition}=require('./infrastructure.cjs');
function band(checkpoint){if(!['CP-500','CP-750'].includes(checkpoint))S.fail('lhcb02-official-checkpoint-id');return definition.checkpoints[checkpoint];}
function remaining(completedStages){
 const ids=definition.candidatePhases;
 if(!Array.isArray(completedStages)||completedStages.length<7||S.json(completedStages)!==S.json(ids.slice(0,completedStages.length))||completedStages.includes('T99'))S.fail('lhcb02-official-checkpoint-phases');
 return ids.slice(completedStages.length).filter(id=>/^E\d{2}$/.test(id)).length;
}
function eligible(pressure,completedStages){const [low,high]=band(definition.officialCheckpoint);return Number.isSafeInteger(pressure)&&pressure>=low&&pressure<=high&&remaining(completedStages)>=definition.minimumContinuationPhases;}
module.exports={band,remaining,eligible};
