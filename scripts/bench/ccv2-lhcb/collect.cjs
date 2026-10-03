'use strict';
const S=require('./state.cjs'),Session=require('./session.cjs'),D=require('./doctor.cjs'),M=require('./metrics.cjs');
function runPath(root,id){if(!/^[A-Za-z0-9_-]+$/.test(id))S.fail('run-id-invalid');return S.inside(root,'runs/'+id);}
function decisionRows(root,run) {
  const file=S.inside(root,'nexus-root/data/logs/aih-controller.log');
  if(!S.fs.existsSync(file))return [];
  const bytes=S.fs.readFileSync(file);if(bytes.length<run.startLogBytes)S.fail('telemetry-truncated');
  const rows=bytes.subarray(run.startLogBytes).toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(x=>x.event==='ccv2-opencode-active-decided');
  // Content-free projection only. Free-form failure details and unrelated controller entries are discarded.
  const keys=['projectionMode','compilerExecutions','fallbackReason','activationDecision','activationReason','activationBasis','activationTokens','pressureTokens','authorityHealth','policyMode','requestSeq'];
  for(const r of rows)if(!['LEGACY','CCV2_COMPILED'].includes(r.projectionMode)||![0,1].includes(r.compilerExecutions)||!['NATIVE','ACTIVATE'].includes(r.activationDecision)||!require('../../../config/ContextActivationPressureV2.cjs').ACTIVATION_REASONS.includes(r.activationReason)||(r.fallbackReason!==null&&(typeof r.fallbackReason!=='string'||!/^active-[a-z0-9-]{1,80}$/.test(r.fallbackReason))))S.fail('telemetry-malformed');
  return rows.map(r=>Object.fromEntries(keys.map(k=>[k,r[k]??null])));
}
function collect(root,id,options={}) {
  S.ready(root);require('./snapshot.cjs').stopped(options);
  const dir=runPath(root,id),run=S.read(S.inside(dir,'run.json'));
  if(S.fs.existsSync(S.inside(dir,'metrics.json')))S.fail('run-already-collected');
  const current=S.read(S.inside(root,'state/current.json'));if(current.runId!==id)S.fail('run-not-current');
  const reasons=[];let b,events=[],activation={rows:[],summary:null},decisions=[];
  try {b=Session.binding(root);if(b.sessionId!==run.sessionId||b.taskInstanceId!==run.taskInstanceId)S.fail('identity-mismatch');if(b.events.length<run.startSeq)S.fail('log-truncated');events=b.events.slice(run.startSeq);activation=Session.activation(b.events,root,run.arm);activation.rows=activation.rows.filter((r)=>events.some(e=>e.type==='assistant/message'&&e.data.turn===r.turn&&e.data.step===r.step));}catch{reasons.push('corrupted-or-missing-session-log');}
  try {decisions=decisionRows(root,run);}catch{reasons.push('corrupted-or-missing-telemetry');}
  if(!D.sourceGuard(S.REPO,S.inside(root,'nexus-root')).pass)reasons.push('frozen-source-drift');
  if(D.certification(root).health!=='HEALTHY')reasons.push('unhealthy-certification');
  try {if(D.identity(root)!==run.settingsIdentityHash)reasons.push('settings-identity-drift');}catch{reasons.push('settings-identity-drift');}
  try{const policy=S.read(S.inside(root,'nexus-root/config/routing-policy.json'));if(S.hash(S.json(policy))!==run.policyHash)reasons.push('arm-policy-drift');}catch{reasons.push('arm-policy-missing-or-corrupt');}
  try{const binds=S.read(S.inside(root,'nexus-root/data/routing/session-bindings.json'));if(Object.keys(binds.bindings||{}).length!==1)reasons.push('nonexclusive-session');}catch{reasons.push('binding-evidence-missing-or-corrupt');}
  // Route headers are durable DSH evidence, not operator assertions. Include inherited latest route.
  let routeSeen=false;for(const e of b?.events||[]){let cfg=e.type==='request/context'?e.data:e.type==='request/header'?e.data.header?.config:null;if(cfg){routeSeen=true;if(cfg.provider!==run.provider||cfg.model!==run.model)reasons.push('wrong-model-provider');}}
  if(!routeSeen)reasons.push('unobserved-model-provider');
  const t99=S.fs.readFileSync(S.path.join(S.BENCH,'prompts/T99-final-challenge.md'),'utf8');
  const delivered=events.some(e=>e.type==='user/message'&&Array.isArray(e.data.content)&&Session.promptContent(e.data.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'))===Session.promptContent(t99));
  const challenge=events.find(e=>e.type==='user/message'&&Array.isArray(e.data.content)&&Session.promptContent(e.data.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'))===Session.promptContent(t99));const finished=events.some(e=>e.type==='turn/end'&&e.seq>challenge?.seq&&e.data.reason?.kind==='completed');
  if(!delivered||!finished)reasons.push('challenge-not-delivered-or-incomplete');
  const complete=reasons.length===0&&(run.arm==='native'?decisions.length===0:decisions.length===events.filter(e=>e.type==='assistant/message').length);
  const times=events.map(e=>e.time).filter(x=>Number.isFinite(x));
  const metrics=M.collectMetrics(events,decisions,run.arm,{telemetryComplete:complete,replayRows:activation.rows,wallClockMs:times.length===events.length&&times.length?Math.max(...times)-Math.min(...times):null});
  let derived;try{derived=require('../../../config/ContextActivationPressureV2.cjs').deriveActivationThresholdsV2(D.route(root));}catch{derived=S.read(S.inside(dir,'preflight.json')).thresholds;reasons.push('route-unavailable');}metrics.activationBasis=derived.basis;metrics.activationThreshold=derived.activationTokens;delete metrics.availability.activationBasis;delete metrics.availability.activationThreshold;
  metrics.infrastructureReasons=[...new Set([...metrics.infrastructureReasons,...reasons])].sort();metrics.infrastructureInvalid=metrics.infrastructureReasons.length>0;
  const validation=M.validateArm(metrics,run.arm);
  let workspaceHash=null;try{workspaceHash=S.treeHash(S.inventory(S.inside(root,'workspace')));}catch{metrics.infrastructureReasons.push('workspace-evidence-unsafe-or-missing');metrics.infrastructureInvalid=true;}
  const result={...run,...metrics,workspaceHash,taskSuccess:null,finalTestsPass:null,criticalObligationsPassed:null,criticalObligationsTotal:10,obligationsPassed:null,obligationsTotal:20,runStatus:metrics.infrastructureInvalid?'INFRA_INVALID':validation.status,invalidReason:validation.reason,correctnessGate:null};
  for(const k of ['taskSuccess','finalTestsPass','criticalObligationsPassed','obligationsPassed','correctnessGate'])result.availability[k]={available:false,reason:'Run has not been graded'};
  S.validateSchema(result,'result');S.write(S.inside(dir,'activation.json'),activation);S.write(S.inside(dir,'metrics.json'),metrics);S.write(S.inside(dir,'result.json'),result);return result;
}
function gradeRun(root,id){
  S.ready(root);const dir=runPath(root,id),r=S.read(S.inside(dir,'result.json')),current=S.read(S.inside(root,'state/current.json'));
  if(current.runId!==id)S.fail('grade-before-restoring-another-run');if(S.treeHash(S.inventory(S.inside(root,'workspace')))!==r.workspaceHash)S.fail('workspace-changed-after-collection');
  const g=require('../../../benchmarks/ccv2-lhcb-01/grader/grade.cjs').grade(S.inside(root,'workspace'));
  Object.assign(r,{taskSuccess:g.taskSuccess,finalTestsPass:g.finalTestsPass,criticalObligationsPassed:g.critical.passed,criticalObligationsTotal:g.critical.total,obligationsPassed:g.obligations.passed,obligationsTotal:20});r.correctnessGate=require('./score.cjs').correctness(r);
  for(const k of ['taskSuccess','finalTestsPass','criticalObligationsPassed','obligationsPassed','correctnessGate'])delete r.availability[k];
  S.validateSchema(r,'result');S.write(S.inside(dir,'grade.json'),g);S.write(S.inside(dir,'result.json'),r);return g;
}
module.exports={collect,gradeRun,decisionRows,runPath};
