'use strict';
const S=require('./state.cjs'), D=require('./doctor.cjs');
const log=require('../../lib/Ccv2SessionLog.cjs');
const replay=require('../../CCv2-ActivationReplay.cjs');
const gate=require('../../../config/ContextActivationPressureV2.cjs');
function decode(root,relative) {const parsed=log.readSessionLog(S.inside(root,relative),{installRoot:S.inside(root,'nexus-root')});if(!Number.isInteger(parsed.header.version)||!Number.isSafeInteger(parsed.header.createdAt)||parsed.events.some(e=>typeof e.type!=='string'||!Number.isSafeInteger(e.time)||e.time<0||!e.data||typeof e.data!=='object'))S.fail('session-envelope-invalid');surfaceMessages(parsed.events,root);return parsed;}
function binding(root) {
  const expected=S.read(S.inside(root,'state/binding.json'));
  const raw=S.read(S.inside(root,'nexus-root/data/routing/session-bindings.json'));
  const b=raw.bindings?.[expected.sessionId];
  if(!b || b.taskId!==expected.taskId || b.taskInstanceId!==expected.taskInstanceId || S.path.resolve(b.workspace)!==S.inside(root,'workspace'))S.fail('binding-mismatch');
  const parsed=decode(root,expected.sessionLog);
  if(parsed.header.id!==expected.sessionId || parsed.header.cwd!==S.inside(root,'workspace'))S.fail('session-mismatch');
  const task=S.read(S.inside(root,'workspace/.ai-harness/runs/'+expected.taskId+'/manifest.json'));
  if(task.taskId!==expected.taskId||task.taskInstanceId!==expected.taskInstanceId)S.fail('task-mismatch');
  return {...expected,events:parsed.events};
}
function bind(root,relative) {
  S.ready(root);
  if(!/^nexus-root\/data\/sessions\/[^/]+\/[^/]+\/session\.jsonl(?:\.zstd)?$/.test(relative))S.fail('session-path-invalid');
  const parsed=decode(root,relative);
  const raw=S.read(S.inside(root,'nexus-root/data/routing/session-bindings.json'));
  const b=raw.bindings?.[parsed.header.id];
  if(!b||!/^TASK-\d+$/.test(b.taskId)||typeof b.taskInstanceId!=='string')S.fail('binding-missing');
  const expected={sessionId:parsed.header.id,taskId:b.taskId,taskInstanceId:b.taskInstanceId,sessionLog:relative};
  S.write(S.inside(root,'state/binding.json'),expected);binding(root);return expected;
}
function surfaceMessages(events,root){const codec=log.loadDshSessionModule(S.inside(root,'nexus-root'));return codec.foldSurface(events).nodes.map(seq=>codec.deriveEventMessage(events[seq])).filter(Boolean);}
function activation(events,root,arm='production') {
  const mode=gate.resolveActivationModeV2({contextCompiler:S.manifest.arms[arm]});
  const r=D.route(root),rows=replay.replayActivationV2(events,r,mode);
  // Existing replay is exact for append-only logs. After replacements, use DSH's canonical fold, never an invented surface decoder.
  if(events.some(e=>e.surfaceOp&&e.surfaceOp!=='append')){for(const row of rows){const event=events.find(e=>e.type==='assistant/message'&&e.data.turn===row.turn&&e.data.step===row.step);const prior=events.slice(0,event.seq);const d=gate.decideActivationV2({events:prior,messages:surfaceMessages(prior,root),route:r,mode});Object.assign(row,{decision:d.decision,reason:d.reason,detail:d.detail,pressureTokens:d.pressureTokens,latchTokens:d.latchTokens,boundHolds:row.actualPrompt===null||d.pressureTokens===null?null:d.pressureTokens>=row.actualPrompt});}}
  return {rows,summary:replay.summarize(rows,gate.deriveActivationThresholdsV2(r))};
}
function currentPressure(root) {
  const b=binding(root),surface=surfaceMessages(b.events,root);
  const decision=gate.decideActivationV2({events:b.events,messages:surface,route:D.route(root),mode:gate.resolveActivationModeV2({contextCompiler:S.manifest.arms.production})});
  return {...decision,sessionId:b.sessionId,taskId:b.taskId,taskInstanceId:b.taskInstanceId};
}
function promptContent(text){return text.replace(/\r\n/g,'\n').replace(/\n$/,'');}
function verifyStages(root,b,stages){for(const stage of stages){if(stage.expectedSessionId&&stage.expectedSessionId!==b.sessionId)S.fail('stage-session-mismatch');const file=S.fs.readdirSync(S.path.join(S.BENCH,'prompts')).find(f=>f.startsWith(stage.stage+'-'));if(!file)S.fail('stage-invalid');const text=S.fs.readFileSync(S.path.join(S.BENCH,'prompts',file),'utf8');if(stage.promptHash!==S.hash(text))S.fail('stage-prompt-drift');const delivered=b.events.find(e=>e.seq>=stage.startSeq&&e.type==='user/message'&&Array.isArray(e.data.content)&&promptContent(e.data.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'))===promptContent(text));if(!delivered)S.fail('stage-not-delivered');if(!b.events.some(e=>e.seq>delivered.seq&&e.type==='turn/end'&&e.data.reason?.kind==='completed'))S.fail('stage-not-completed');}return true;}
function prompt(root,stage,options={}) {
  S.ready(root);if(stage==='next'){const stagesFile=S.inside(root,'state/stages.json');const count=S.fs.existsSync(stagesFile)?S.read(stagesFile).length:0;stage=S.manifest.stages[Math.min(count,S.manifest.stages.length-1)];}if(!S.manifest.stages.includes(stage))S.fail('unknown-stage');
  const file=S.fs.readdirSync(S.path.join(S.BENCH,'prompts')).find(f=>f.startsWith(stage+'-'));
  const text=S.fs.readFileSync(S.path.join(S.BENCH,'prompts',file),'utf8');
  const stagesFile=S.inside(root,'state/stages.json'), stages=S.fs.existsSync(stagesFile)?S.read(stagesFile):[];
  let b=null;try{b=binding(root);}catch{if(stage!=='T00')S.fail('bind-session-first');}
  if(b&&stages.length)verifyStages(root,b,stages);
  if(stages.some(x=>x.stage===stage)&&!(options.repeat&&/^P0[1-7]$/.test(stage)))S.fail('stage-already-issued');
  const next=S.manifest.stages[stages.length];if(!options.repeat&&stage!==next&&stage!=='T99')S.fail('stage-out-of-order');if(stage==='T99'&&!S.manifest.stages.slice(0,8).every(x=>stages.some(s=>s.stage===x)))S.fail('finish-audits-first');if(options.repeat&&(!/^P0[1-7]$/.test(stage)||!S.manifest.stages.slice(0,8).every(x=>stages.some(s=>s.stage===x))))S.fail('repeat-audits-only');
  const record={stage,promptHash:S.hash(text),expectedSessionId:b?.sessionId||null,startSeq:b?.events.length||0,workspaceHash:S.treeHash(S.inventory(S.inside(root,'workspace')))};
  if(stage!=='T99'&&stages.length){ const prior=stages.at(-1); if(S.treeHash(S.inventory(S.inside(root,'workspace')))!==prior.workspaceHash){
    // Runtime ledger and Git internals are allowed to evolve; source edits are checked separately.
    const source=S.read(S.inside(root,'state/fixture.json')).fileHashes;
    for(const [p,h] of Object.entries(source))if(S.hash(S.fs.readFileSync(S.inside(root,'workspace/'+p)))!==h)S.fail('read-only-stage-modified-source');
  }}
  stages.push(record);S.write(stagesFile,stages);return {record,text};
}
module.exports={promptContent,verifyStages,surfaceMessages,decode,binding,bind,activation,currentPressure,prompt};
