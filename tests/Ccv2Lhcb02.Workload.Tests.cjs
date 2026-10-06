'use strict';
require('../benchmarks/ccv2-lhcb-01/grader/offline.cjs');
const {test,after}=require('node:test'),assert=require('node:assert/strict'),cp=require('node:child_process');
const {S}=require('../scripts/bench/ccv2-lhcb-02/infrastructure.cjs'),C=require('../scripts/bench/ccv2-lhcb-02/candidate.cjs');
const F=require('../benchmarks/ccv2-lhcb-02/fixture/create-fixture.cjs'),L=require('../benchmarks/ccv2-lhcb-02/fixture/late.cjs'),FinalFixture=require('../benchmarks/ccv2-lhcb-02/fixture/final.cjs'),G=require('../benchmarks/ccv2-lhcb-02/grader/final.cjs');
const graph=require('../benchmarks/ccv2-lhcb-02/phase-manifest.json'),O=require('../benchmarks/ccv2-lhcb-02/obligations.json');
const tmp=S.fs.mkdtempSync(S.path.join(S.os.tmpdir(),'lhcb02-full-'));let serial=0;
after(()=>{assert.equal(global.lhcbOfflineAudit.attempts(),0);S.fs.rmSync(tmp,{recursive:true,force:true});});
function make(reference=false){const dir=S.path.join(tmp,'fixture-'+(++serial));C.reconstruct(dir);if(reference){for(const id of S.manifest.calibration.phases){const text='const scales={USD:2,EUR:2,JPY:0,KWD:3};const oracle='+F.oracle.toString()+';module.exports={evaluate:x=>oracle('+JSON.stringify(id)+',x)};';S.fs.writeFileSync(S.path.join(dir,'src/'+F.modules[id]+'.ts'),text);for(const [p,code] of Object.entries(F.referenceIntegrationFiles(id)))S.fs.writeFileSync(S.path.join(dir,p),code);}for(const [id,name] of L.specs){S.fs.writeFileSync(S.path.join(dir,'src/'+name+'.ts'),L.reference(name));for(const [p,code] of Object.entries(F.referenceIntegrationFiles(id)))S.fs.writeFileSync(S.path.join(dir,p),code);}for(const [id,name] of require('../benchmarks/ccv2-lhcb-02/fixture/extensions.cjs').specs)S.fs.writeFileSync(S.path.join(dir,'src/'+name+'.ts'),require('../benchmarks/ccv2-lhcb-02/fixture/extensions.cjs').reference(name));for(const [id,name] of require('../benchmarks/ccv2-lhcb-02/fixture/workflows.cjs').specs)S.fs.writeFileSync(S.path.join(dir,'src/'+name+'.ts'),require('../benchmarks/ccv2-lhcb-02/fixture/workflows.cjs').reference(name));S.fs.writeFileSync(S.path.join(dir,'src/canonical-statements.ts'),require('../benchmarks/ccv2-lhcb-02/fixture/canonical-statements.cjs').reference());S.fs.writeFileSync(S.path.join(dir,'src/application.ts'),FinalFixture.reference());}return dir;}
let referenceDir;function reference(){return referenceDir||(referenceDir=make(true));}
test('full graph has 46 engineering phases, T00 and T99 with backward dependencies only',()=>{assert(C.validateGraph());assert.equal(C.phases().length,48);const seen=new Set();for(const p of graph.phases){assert(p.dependsOn.every(d=>seen.has(d)));assert.equal(p.status,'implemented');seen.add(p.id);}assert.equal(S.manifest.status,'UNFROZEN');assert.equal(S.manifest.liveCalibration,'LIVE_CALIBRATION_REQUIRED');assert.equal(S.manifest.officialExecutionEnabled,false);});
for(const id of C.phases())test('deterministic and nonduplicate artifacts: '+id,()=>{assert.deepEqual(C.artifacts(id),C.artifacts(id));const f=C.fingerprint(id);assert.deepEqual(f,C.fingerprint(id));assert(f.files.length>=3);assert(f.bytes>100);if(id!=='T00'){const cases=F.cases(id);assert(cases.length>=3);assert.equal(new Set(cases.map(r=>S.json(r.input))).size,cases.length);assert(cases.every(r=>r.expected!==undefined));}for(const file of f.files){const text=C.artifacts(id)[file.path];assert.doesNotMatch(text,/lorem ipsum|padding token|repeat\(100000/i);assert(file.bytes<500000);}});
test('evidence sets and source modules are unique across all phases',()=>{const rows=C.phases().map(C.fingerprint);assert.equal(new Set(rows.map(r=>r.setHash)).size,48);assert.equal(new Set(Object.values(F.modules)).size,47);});
test('long-distance dependency edges and early middle late T99 prerequisites exist',()=>{const x=C.inspect();assert(x.earlyLateEdges.length>=5);assert(x.maximumDependencyDistance>=20);assert.deepEqual(graph.phases.at(-1).dependsOn,Array.from({length:46},(_,i)=>'E'+String(i+1).padStart(2,'0')));assert(graph.phases.find(p=>p.id==='E14').dependsOn.includes('E03'));assert(graph.phases.find(p=>p.id==='E17').dependsOn.includes('E12'));});
test('every hidden and critical obligation has executable coverage and belongs to an existing phase',()=>{const names=new Set(['integer-money','currency-scale','deny-cross-tenant','tenant-scoped-keys','immutable-import','migration-api-causal-bridge','idempotency-before-revision','service-replay-preserves-commit','single-commit','redact-audit','audit-service-consistency','durable-prefix','no-success-before-commit','injected-clock','authorization-precedes-replay',...L.specs.flatMap(s=>['contract-'+s[1],'journey-'+s[1]]),...require('../benchmarks/ccv2-lhcb-02/fixture/workflows.cjs').specs.flatMap(s=>['workflow-contract-'+s[1],'workflow-execution-'+s[1]]),...require('../benchmarks/ccv2-lhcb-02/fixture/extensions.cjs').specs.flatMap(s=>['extension-contract-'+s[1],'extension-integration-'+s[1]]),'retry-commit-bridge','gateway-contract-bridge','atomic-store-bridge','final-coordinator','statement-page-contract','statement-page-execution']);for(const o of O.obligations){assert(C.phases().includes(o.introducedBy));assert.equal(o.status,'implemented');assert(o.probeIds.length>0);assert(o.probeIds.every(p=>names.has(p)));assert.equal(o.t99,true);assert(graph.phases.find(p=>p.id===o.introducedBy).obligations.includes(o.id));}assert.equal(O.categories.length,9);assert(O.obligations.filter(o=>o.critical).length>12);});
test('prompt bytes and T99 are stable and do not restate hidden obligations',()=>{for(const p of graph.phases){const file=S.path.join(S.BENCH,p.promptFile);assert(S.fs.existsSync(file));const bytes=S.fs.readFileSync(file);assert.equal(S.hash(bytes),S.hash(S.fs.readFileSync(file)));}const t99=S.fs.readFileSync(S.path.join(S.BENCH,'prompts/T99-engineering.md'),'utf8');assert.doesNotMatch(t99,/currency|tenant|replay|prefix|schema|grant|reserved|revoked|integer/i);assert.match(t99,/Scratch protocol revision 1/);const functionalBody=t99.split('\nScratch protocol revision 1:')[0];assert.equal(S.hash(functionalBody),'e34bafce498b56aa99bd382a644ecfe71b30ad24302384b712d0ef70035c3069');});
test('each late incident and final challenge has a real failing implementation',()=>{const dir=make();for(const [id,name] of L.specs){const sandbox=require('../benchmarks/ccv2-lhcb-02/grader/sandbox.cjs').create(dir);let failures=0;for(const r of F.cases(id))try{const actual=sandbox.evaluate(name,r.input);assert.deepEqual(actual.output,r.expected);}catch{failures++;}assert(failures>0,id);}assert.equal(G.grade(dir).pass,false);});
test('correct full implementation passes independent final obligation and integration grader',()=>{const result=G.grade(reference());assert.equal(result.pass,true,JSON.stringify(result));assert.equal(result.criticalRatio,1);assert.equal(result.totalRatio,1);assert.equal(result.violations,0);assert.equal(result.tests,'PASS');assert.equal(result.task,'SUCCESS');assert.equal(result.officialBenefitEligible,false);});
test('final grader determinism includes all prior phases',()=>{const a=G.grade(reference()),b=G.grade(reference());assert.deepEqual(a,b);assert.equal(a.phases.length,48);assert.equal(a.obligations.length,O.obligations.length);});
for(const name of ['domain','migrations','authorization','reservations','retry','grants','gateway','client','batch'])test('final grading detects lost earlier or later contract: '+name,()=>{const dir=make(true),file=S.path.join(dir,'src/'+name+'.ts');S.fs.writeFileSync(file,'module.exports={evaluate:()=>({}),dispatch:()=>({status:201}),run:()=>({status:201}),apply:()=>({status:201})};');const result=G.grade(dir);assert.equal(result.pass,false);assert.equal(result.tests,'FAIL');});
test('T99 superficial successful report fails without implementation',()=>{const dir=make(true);S.fs.writeFileSync(S.path.join(dir,'src/application.ts'),FinalFixture.source());const result=G.grade(dir);assert.equal(result.task,'FAIL');assert.equal(result.pass,false);});
test('immutable evidence mutation and forged workspace verifier cannot pass final gate',()=>{const dir=make(true);S.fs.appendFileSync(S.path.join(dir,'evidence/E19/trace.json'),' ');S.fs.writeFileSync(S.path.join(dir,'tools/verify.cjs'),'console.log("PASS");');const result=G.grade(dir);assert.equal(result.pass,false);assert(result.violations>=2);});
test('read-only evidence and intended inspections are objective phase gates',()=>{const dir=reference(),id='T99';const before=S.inventory(dir);const events=Object.entries(C.artifacts(id)).filter(([p])=>p.startsWith('src/')||p.endsWith('incident.json')).map(([p,text])=>({type:'tool/result',data:{message:{content:[{type:'tool-result',toolCallId:p,content:[{type:'text',text}]}]}}}));assert.equal(C.phaseAcceptance({dir,id,events:[],before}).inspected,false);assert.equal(C.phaseAcceptance({dir,id,events,before}).sourceChanged,false);const snapshot=structuredClone(before);snapshot['src/application.ts'].hash=S.hash('broken');const result=C.phaseAcceptance({dir,id,events,before:snapshot});assert.equal(result.pass,true,JSON.stringify(result));});
test('offline A/B/C clone reproduces identical workspace durable state session and T99 bytes',()=>{const root=S.path.join(tmp,'baseline');S.fs.mkdirSync(root);S.fs.cpSync(reference(),S.path.join(root,'workspace'),{recursive:true});for(const dir of ['state','durable'])S.fs.mkdirSync(S.path.join(root,dir));S.write(S.path.join(root,'state/identity.json'),{sessionId:'session-offline',taskId:'TASK-0001',taskInstanceId:'fixed'});S.fs.writeFileSync(S.path.join(root,'durable/session.jsonl'),'offline durable equivalence evidence\n');S.fs.copyFileSync(S.path.join(S.BENCH,'prompts/T99-engineering.md'),S.path.join(root,'state/T99.prompt'));const snapshots=require('../scripts/bench/ccv2-lhcb-02/candidate-snapshot.cjs'),seal=snapshots.seal(root);const rows=['A','B','C'].map(arm=>snapshots.restore(seal,S.path.join(tmp,'arm-'+arm)));assert.deepEqual(rows[0],rows[1]);assert.deepEqual(rows[1],rows[2]);for(const arm of ['A','B','C'])assert.equal(S.hash(S.fs.readFileSync(S.path.join(tmp,'arm-'+arm+'/state/T99.prompt'))),S.hash(S.fs.readFileSync(S.path.join(S.BENCH,'prompts/T99-engineering.md'))));assert.equal(rows[0].officialBenefitEligible,false);const corrupt=structuredClone(seal);corrupt.entries[0].bytes=Buffer.from('changed').toString('base64');assert.throws(()=>snapshots.restore(corrupt,S.path.join(tmp,'corrupt')),/invalid|seal/);assert(!S.fs.existsSync(S.path.join(tmp,'corrupt')));});
test('workload reconstruction works in a clean checkout without installed dependencies',()=>{const dir=S.path.join(tmp,'child-fixture'),checkout=S.path.join(tmp,'clean-checkout');for(const relative of ['benchmarks/ccv2-lhcb-01','benchmarks/ccv2-lhcb-02','scripts/bench/ccv2-lhcb','scripts/bench/ccv2-lhcb-02'])S.fs.cpSync(S.path.join(S.REPO,relative),S.path.join(checkout,relative),{recursive:true});const result=cp.spawnSync(process.execPath,['--require',S.path.join(checkout,'benchmarks/ccv2-lhcb-02/grader/offline.cjs'),S.path.join(checkout,'scripts/bench/ccv2-lhcb-02/cli.cjs'),'reconstruct',dir],{cwd:checkout,encoding:'utf8',env:{PATH:process.env.PATH,HOME:S.os.homedir()}});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).providerCalls,0);const second=make();assert.equal(S.treeHash(S.inventory(dir)),S.treeHash(S.inventory(second)));assert.throws(()=>C.reconstruct(dir),/nonempty/);});
test('inspector is content-free and byte/token estimates cannot claim pressure or eligibility',async()=>{const report=await require('../scripts/bench/ccv2-lhcb-02/cli.cjs').main(['inspect']);assert.equal(report.authority,'NON-AUTHORITATIVE');assert.equal(report.tokenEstimate,null);assert.equal(report.totalPhases,48);assert.equal(report.t99ObligationCoverage,O.obligations.length);assert.doesNotMatch(JSON.stringify(report),/private-case|private-value|prepared suffix|Integer/);assert(report.totalEvidenceBytes>10000);assert.equal(require('../scripts/bench/ccv2-lhcb-02/validity.cjs').workload(report).officialBenefitEligible,false);});
test('every late phase has a distinct withheld business input',()=>{for(const [id] of L.specs){const visible=new Set(L.cases(id).map(r=>S.json(r.input)));assert(L.cases(id,true).some(r=>!visible.has(S.json(r.input))),id);}});
test('progressive acceptance proves inspections edits and previous constraints at every stage',()=>{const dir=S.path.join(tmp,'progressive');F.createFixture(dir);for(const id of C.phases()){if(id!=='T00')F.release(dir,id);const before=S.inventory(dir);const events=Object.entries(C.artifacts(id)).filter(([p])=>p.startsWith('src/')||p.endsWith('incident.json')).map(([p,text],i)=>({seq:i,type:'tool/result',data:{message:{content:[{type:'tool-result',toolCallId:'read-'+i,content:[{type:'text',text}]}]}}}));if(id!=='T00'){const name=F.modules[id];const source=id==='T99'?FinalFixture.reference():S.manifest.calibration.phases.includes(id)?'const scales={USD:2,EUR:2,JPY:0,KWD:3};const oracle='+F.oracle.toString()+';module.exports={evaluate:x=>oracle('+JSON.stringify(id)+',x)};':require('../benchmarks/ccv2-lhcb-02/fixture/extensions.cjs').specs.some(s=>s[1]===name)?require('../benchmarks/ccv2-lhcb-02/fixture/extensions.cjs').reference(name):require('../benchmarks/ccv2-lhcb-02/fixture/workflows.cjs').specs.some(s=>s[1]===name)?require('../benchmarks/ccv2-lhcb-02/fixture/workflows.cjs').reference(name):name==='canonical-statements'?require('../benchmarks/ccv2-lhcb-02/fixture/canonical-statements.cjs').reference():L.reference(name);S.fs.writeFileSync(S.path.join(dir,'src/'+name+'.ts'),source);for(const [p,code] of Object.entries(F.referenceIntegrationFiles(id)))S.fs.writeFileSync(S.path.join(dir,p),code);}const result=C.phaseAcceptance({dir,id,events,before});assert.equal(result.pass,true,id+':'+JSON.stringify(result));}});
test('graph rejects cycles nonexistent late edges and duplicate phase identities',()=>{for(const corrupt of [()=>graph.phases[1].dependsOn.push('E24'),()=>graph.phases[14].dependsOn.push('missing'),()=>graph.phases[8].id='E07']){const original=structuredClone(graph.phases);try{corrupt();assert.throws(()=>C.validateGraph(),/graph/);}finally{graph.phases.splice(0,graph.phases.length,...original);}}});
test('phase acceptance fails closed without baseline authority',()=>{assert.throws(()=>C.phaseAcceptance({dir:reference(),id:'T99',events:[]}),/baseline-missing/);});
test('renaming phase paths and case IDs cannot manufacture new business evidence',()=>{const files=C.artifacts('E19'),renamed={};for(const [path,content] of Object.entries(files)){const name=path.replace('E19','E25');renamed[name]=path.endsWith('.jsonl')?content.trim().split('\n').map(JSON.parse).map((r,i)=>({...r,caseId:'E25-'+i})).map(JSON.stringify).join('\n')+'\n':content;}const a=C.fingerprintFiles('E19',files),b=C.fingerprintFiles('E25',renamed);assert.notEqual(a.setHash,b.setHash);assert.equal(a.semanticSetHash,b.semanticSetHash);assert.equal(C.inspect().uniqueSemanticEvidenceSets,48);assert.equal(C.inspect().repeatedSemanticEvidenceSets,0);});
test('released T99 smoke checks do not reveal hidden earlier obligation answers',()=>{const rows=FinalFixture.publicCases();assert.equal(rows.length,2);for(const row of rows){assert.deepEqual(Object.keys(row.expected).sort(),['hasCommit','status']);assert.equal(row.input.document.version,3);assert.equal(row.input.actor.revoked,false);assert.equal(row.input.failures[0],'none');}const released=FinalFixture.phaseFiles()['evidence/T99/cases.jsonl'];assert.doesNotMatch(released,/txn-1|committedAt|auditSuccess|prepared|unknown-schema|holdout|terminal|minorUnits|"version":1/);assert(FinalFixture.cases(true).length>rows.length);});
test('public T99 verifier needs an actual commit and passes real reference integration',()=>{const dir=make(true),file=S.path.join(dir,'tools/verify.cjs');const result=cp.spawnSync(process.execPath,['--require',S.path.join(S.BENCH,'grader/offline.cjs'),file,'T99'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);S.fs.writeFileSync(S.path.join(dir,'src/application.ts'),FinalFixture.source());const broken=cp.spawnSync(process.execPath,['--require',S.path.join(S.BENCH,'grader/offline.cjs'),file,'T99'],{encoding:'utf8'});assert.equal(broken.status,1);assert(JSON.parse(broken.stdout).failures>0);});
test('candidate CLI grading is bounded and fails closed when worker observation is unavailable',async()=>{const spawn=cp.spawnSync;let options;try{cp.spawnSync=(_node,_args,opts)=>{options=opts;return {status:null,stdout:'',error:new Error('offline worker interruption')};};const result=await require('../scripts/bench/ccv2-lhcb-02/cli.cjs').main(['grade-candidate',reference()]);assert.equal(result.pass,false);assert.equal(result.tests,'UNAVAILABLE');assert.equal(options.timeout,300000);assert.equal(options.env.OPENCODE_API_KEY,undefined);}finally{cp.spawnSync=spawn;}});

test('public integration verifier exercises supported callers and detects mandatory-grant regression',()=>{
 const dir=make(true),file=S.path.join(dir,'tools/verify-integration.cjs');assert(S.fs.existsSync(file));
 const run=()=>cp.spawnSync(process.execPath,['--require',S.path.join(S.BENCH,'grader/offline.cjs'),file],{encoding:'utf8'});
 assert.equal(run().status,0);
 const auth=S.path.join(dir,'src/authorization.ts');S.fs.appendFileSync(auth,"\nconst original=module.exports.evaluate;module.exports.evaluate=x=>x.grant?original(x):{allowed:false,audit:{}};\n");
 assert.equal(run().status,1);
});

test('new import consumer defect is observable through public callers without changing hidden expectations',()=>{
 const dir=make(true),file=S.path.join(dir,'tools/verify-integration.cjs');
 const run=()=>cp.spawnSync(process.execPath,['--require',S.path.join(S.BENCH,'grader/offline.cjs'),file],{encoding:'utf8'});
 S.fs.writeFileSync(S.path.join(dir,'src/import-service.ts'),F.phaseFiles('E03')['src/import-service.ts']);assert.equal(run().status,1);assert.equal(G.grade(dir).pass,false);
 S.fs.writeFileSync(S.path.join(dir,'src/import-service.ts'),F.referenceIntegrationFiles('E03')['src/import-service.ts']);assert.equal(run().status,0);assert.equal(G.grade(dir).pass,true);
});

test('public import boundary covers distinct caller contracts and catches metadata mutation',()=>{
 const dir=make(true),file=S.path.join(dir,'tools/verify-import.cjs');const run=()=>cp.spawnSync(process.execPath,['--require',S.path.join(S.BENCH,'grader/offline.cjs'),file],{encoding:'utf8'});
 assert.equal(run().status,0);const source=S.path.join(dir,'src/import-service.ts');S.fs.appendFileSync(source,"\nconst original=module.exports.postImported;module.exports.postImported=(store,doc,...rest)=>{delete doc.writerRevision;return original(store,doc,...rest);};\n");assert.equal(run().status,1);assert.equal(G.grade(dir).pass,false);
});

test('E04 public callers distinguish optional metadata and arbitrary supported amount limits',()=>{
 const rows=F.cases('E04');assert(rows.some(r=>r.input.amount===101&&r.expected.commits>0));assert(rows.some(r=>!Object.hasOwn(r.input,'isolation')&&r.expected.commits===1));
 const contract=JSON.parse(F.phaseFiles('E04')['evidence/E04/input-contract.json']);assert(contract.optionalMetadata.includes('isolation'));assert(!contract.required.includes('isolation'));
});
test('T99 declares its coordinator response interface and deterministic caller defaults',()=>{
 const incident=JSON.parse(F.phaseFiles('T99')['evidence/T99/incident.json']);assert.equal(incident.inputContract.defaults.clock,123);assert.equal(incident.inputContract.defaults.requestId,'release');assert.deepEqual(Object.keys(incident.inputContract.successFields).sort(),['status','results','history','recovered','index','exported','rollback','ops','audit','check','clients','release'].sort());
});

test('public batch caller catches partial publication even when evaluate is correct',()=>{
 const dir=make(true),file=S.path.join(dir,'tools/verify-batch.cjs'),source=S.path.join(dir,'src/batch.ts');const run=()=>cp.spawnSync(process.execPath,['--require',S.path.join(S.BENCH,'grader/offline.cjs'),file],{encoding:'utf8'});assert.equal(run().status,0);
 const broken=L.reference('batch').replace('const results=store.applyBatch(context.tenant,commands)',"const results=commands.map(c=>require('./service.ts').post(store,{...c,tenant:context.tenant},actor,clock))");S.fs.writeFileSync(source,broken);assert.equal(run().status,1);assert.equal(G.grade(dir).pass,false);
});

test('integration journey positive control uses real service state and catches a fabricated local-only consumer',()=>{
 const J=require('../benchmarks/ccv2-lhcb-02/fixture/journeys.cjs'),dir=make(true),source=S.path.join(dir,'src/cli-adapter-journey.ts');
 const grader=require('../benchmarks/ccv2-lhcb-02/grader/sandbox.cjs').create(dir);
 for(const input of J.inputs('E07',true)){const result=grader.evaluate('cli-adapter-journey',input);assert.deepEqual(result.output,J.expected(input));assert.deepEqual(result.input,input);}
 S.fs.writeFileSync(source,'module.exports={evaluate:x=>({observations:[],history:[]})};');assert.equal(G.grade(dir).pass,false);
});
test('rollback public contract covers canonical preservation for v1 and v2 including metadata',()=>{
 const rows=L.cases('E16');assert(rows.some(r=>r.input.document.version===1));assert(rows.some(r=>r.input.document.version===2&&r.input.document.writerRevision));
 for(const row of rows)assert.deepEqual(row.expected.canonical,row.input.document);
 const code=L.reference('rollback').replaceAll('canonical:x.document','canonical:{version:3,records:migrated.records}');
 const dir=make(true);S.fs.writeFileSync(S.path.join(dir,'src/rollback.ts'),code);assert.equal(G.grade(dir).pass,false);
});

test('extension integer algorithms satisfy independent conservation and half-even anchors',()=>{
 const E=require('../benchmarks/ccv2-lhcb-02/fixture/extensions.cjs'),dir=reference(),sandbox=require('../benchmarks/ccv2-lhcb-02/grader/sandbox.cjs').create(dir);
 assert.deepEqual(sandbox.evaluate('allocations',{amount:101,weights:[{id:'z',weight:1},{id:'a',weight:1}]}).output,{status:200,allocations:[{id:'z',amount:51},{id:'a',amount:50}],total:101});
 for(const amount of [0,1,17,101,Number.MAX_SAFE_INTEGER]){const output=sandbox.evaluate('allocations',{amount,weights:[{id:'a',weight:3},{id:'b',weight:7},{id:'c',weight:11}]}).output;assert.equal(output.status,200);assert.equal(output.allocations.reduce((s,r)=>s+BigInt(r.amount),0n),BigInt(amount));assert(output.allocations.every(r=>Number.isSafeInteger(r.amount)&&r.amount>=0));}
 for(const [amount,expected] of [[5,2],[7,4],[-5,-2],[-7,-4]])assert.equal(sandbox.evaluate('forex',{amount,numerator:1,denominator:2,rounding:'half-even',from:'JPY',to:'KWD'}).output.amount,expected);
 for(const [id] of E.specs){const visible=new Set(E.cases(id).map(r=>S.json(r.input)));assert(E.cases(id,true).some(r=>!visible.has(S.json(r.input))),id);}
});
test('extension public and host consumers reject detached dependencies and input mutation',()=>{
 const E=require('../benchmarks/ccv2-lhcb-02/fixture/extensions.cjs'),dir=make(true),file=S.path.join(dir,'tools/verify-extension-integration.cjs');
 const run=()=>cp.spawnSync(process.execPath,['--require',S.path.join(S.BENCH,'grader/offline.cjs'),file,'E25'],{encoding:'utf8'});
 assert.equal(run().status,0);const source=S.path.join(dir,'src/netting.ts'),original=S.fs.readFileSync(source,'utf8');
 S.fs.appendFileSync(source,"\nmodule.exports.integrate=x=>({result:module.exports.evaluate(x.body),dependencies:[]});\n");assert.equal(run().status,1);let probes=require('../benchmarks/ccv2-lhcb-02/grader/extension-probes.cjs').grade(dir,['E25']);assert.equal(probes.probes.find(p=>p.id==='extension-integration-netting').pass,false);
 S.fs.writeFileSync(source,original+"\nconst saved=module.exports.evaluate;module.exports.evaluate=x=>{const r=saved(x);x.tenant='changed';return r;};\n");probes=require('../benchmarks/ccv2-lhcb-02/grader/extension-probes.cjs').grade(dir,['E25']);assert.equal(probes.probes.find(p=>p.id==='extension-contract-netting').pass,false);
});
test('all extension public feature verifiers execute their exact supported contracts',()=>{
 const E=require('../benchmarks/ccv2-lhcb-02/fixture/extensions.cjs'),dir=make(true);
 for(const [id] of E.specs)for(const tool of ['verify-extensions.cjs','verify-extension-integration.cjs']){const r=cp.spawnSync(process.execPath,['--require',S.path.join(S.BENCH,'grader/offline.cjs'),S.path.join(dir,'tools',tool),id],{encoding:'utf8'});assert.equal(r.status,0,id+' '+tool+': '+r.stdout+r.stderr);}
});

test('extension state boundaries have independently stated counterexamples',()=>{
 const s=require('../benchmarks/ccv2-lhcb-02/grader/sandbox.cjs').create(reference()),actor={tenant:'alpha',role:'owner',revoked:false},evalFeature=(name,input)=>s.evaluate(name,input).output;
 const entry=(account,amount,side,currency='JPY')=>({tenant:'alpha',account,amount,side,currency});
 assert.deepEqual(evalFeature('netting',{tenant:'alpha',actor,entries:[entry('001',17,'debit'),entry('001',7,'credit'),entry('other',10,'credit')]}),{status:200,groups:[{tenant:'alpha',currency:'JPY',account:'001',net:-10},{tenant:'alpha',currency:'JPY',account:'other',net:10}],totals:[{currency:'JPY',total:0}]});
 assert.deepEqual(evalFeature('fee-schedule',{amount:200,currency:'JPY',kind:'transfer',tiers:[{upTo:100,bps:100},{upTo:300,bps:200}],cap:2}),{status:200,fee:2,net:198,tiers:[{upTo:100,base:100,fee:1},{upTo:300,base:100,fee:2}]});
 const instruction=(id,amount,expires=20)=>({id,tenant:'alpha',account:'001',amount,currency:'JPY',due:10,expires,state:'pending'});
 assert.deepEqual(evalFeature('scheduler',{tenant:'alpha',actor,now:20,balance:7,instructions:[instruction('expired',1),instruction('large',9,21),instruction('small',3,21)]}),{status:200,ready:[{id:'small',account:'001',amount:3,currency:'JPY'}],expired:['expired'],deferred:[],rejected:['large'],available:4});
 const event={tenant:'alpha',id:'001',revision:1,state:'committed',checksum:'valid',operation:'post',account:'001',amount:17,currency:'JPY',authorization:'<fixture>'};
 assert.deepEqual(evalFeature('outbox',{journal:[event,{...event,id:'cut',state:'prepared'},{...event,id:'later',revision:2}],limit:1,acks:[{tenant:'beta',id:'001',revision:1}]}),{status:200,deliver:[{tenant:'alpha',id:'001',revision:1,payload:{operation:'post',account:'001',amount:17,currency:'JPY'}}],remaining:0,ignoredSuffix:2});
 const action=(op,owner,now,term)=>({op,owner,now,term,tenant:'alpha',name:'001',ttl:10,actor});
 const leases=evalFeature('leases',{actions:[action('acquire','a',0,0),action('acquire','b',10,0),action('write','a',10,1),action('write','b',10,2)]});assert.deepEqual(leases.results,[{status:201,term:1,expiresAt:10},{status:201,term:2,expiresAt:20},{status:409},{status:200,term:2,expiresAt:20}]);
 const row=revision=>({tenant:'alpha',account:'001',revision,amount:17});assert.deepEqual(evalFeature('statement-pages',{tenant:'alpha',account:'001',through:2,limit:1,cursor:null,rows:[row(3),row(2),row(1)]}),{status:200,rows:[row(1)],next:'["alpha","001",2,1]',examined:1});
 const segment=revision=>({id:'s'+revision,revision,state:'committed',checksum:'valid'});assert.deepEqual(evalFeature('retention',{floor:2,pins:[],segments:[segment(1),segment(2),segment(3)]}),{status:200,retained:[segment(2),segment(3)],archived:[segment(1)],quarantine:[]});
 const a={...entry('001',17,'debit'),transactionId:'txn',entryId:'a'},b={...entry('other',17,'credit'),transactionId:'txn',entryId:'b'};assert.equal(evalFeature('reconciliation',{entries:[a,b]}).balanced,true);assert.equal(evalFeature('reconciliation',{entries:[a,b,{...a}]}).balanced,false);
 assert.deepEqual(evalFeature('closing-state',{tenant:'alpha',state:'active',balance:0,holds:[],actions:[{op:'close',actor},{op:'reopen',actor}]}),{state:'closed',results:[{status:200,state:'closed'},{status:409,state:'closed'}],balance:0});
 const cell={version:1,surface:'cli',permission:'writer',expectedStatus:201,critical:true};assert.deepEqual(evalFeature('rollout',{required:[cell],observations:[],quarantine:[],originals:[]}),{ready:false,ratio:0,failed:['[1,"cli","writer"]'],criticalFailed:['[1,"cli","writer"]'],missingOriginals:[]});
 const accounts=[{tenant:'alpha',id:'001',balance:17,revision:1}];assert.deepEqual(evalFeature('import-merge',{tenant:'alpha',actor,accounts,document:{version:2,records:[{id:'001',amount:3,currency:'JPY',kind:'transfer',expectedRevision:1},{id:'later',amount:5,currency:'JPY',kind:'transfer',expectedRevision:1}]}}),{status:409,accounts,changes:[]});
 const feed={tenant:'alpha',seq:1,id:'001',payload:{amount:17}};assert.deepEqual(evalFeature('change-feed',{tenant:'alpha',after:0,limit:1,events:[feed,Object.fromEntries(Object.entries(feed).reverse())]}),{status:200,events:[feed],cursor:1});
 const shared={revision:1,state:'committed',checksum:'valid',balance:17};assert.deepEqual(evalFeature('replica-prefix',{primary:[shared],replica:[{...shared,balance:19}]}),{status:409,canonical:[],quarantine:[shared,{...shared,balance:19}]});
 assert.equal(evalFeature('access-policy',{tenant:'alpha',operation:'post',requestId:'001',actor:{tenant:'alpha',roles:['writer'],revoked:false},roles:[{name:'writer',parents:[]}],rules:[{id:'allow',role:'writer',tenant:'alpha',operation:'post',effect:'allow'},{id:'deny',role:'writer',tenant:'alpha',operation:'*',effect:'deny'}]}).allowed,false);
 assert.deepEqual(evalFeature('repair-plan',{tenant:'alpha',accounts,journal:[{tenant:'alpha',account:'001',revision:1,balance:19,state:'committed',checksum:'valid'}]}),{status:200,repairs:[{tenant:'alpha',id:'001',before:{balance:17,revision:1},after:{balance:19,revision:1}}],untouched:accounts});
 assert.deepEqual(evalFeature('release-matrix',{versions:[1],surfaces:['cli'],scenarios:[{name:'write',status:201,requiresCommit:true}],results:[{version:1,surface:'cli',scenario:'write',status:201,commit:false,mutated:false,violations:0}]}),{ready:false,missing:[],failed:['[1,"cli","write"]'],conflicts:[]});
});

test('stateful settlement reversal and statement phases extend the finite workload without replacing old phases',()=>{
 assert.deepEqual(C.phases().slice(-5),['E43','E44','E45','E46','T99']);
 assert.equal(O.obligations.length,54);assert.equal(O.obligations.filter(o=>o.critical).length,19);
 for(const id of ['E43','E44','E45'])assert(graph.phases.find(p=>p.id===id).dependsOn.includes('E03'));
});

test('stateful workflow public and withheld controls observe real atomic balances and durable identities',()=>{
 const W=require('../benchmarks/ccv2-lhcb-02/fixture/workflows.cjs'),dir=reference(),sandbox=require('../benchmarks/ccv2-lhcb-02/grader/sandbox.cjs').create(dir);
 for(const [id,name] of W.specs)for(const hidden of [false,true]){
  const visible=new Set(W.cases(id).map(r=>S.json(r.input)));if(hidden)assert(W.cases(id,true).some(r=>!visible.has(S.json(r.input))),id);
  for(const row of W.cases(id,hidden)){const result=sandbox.evaluate(name,row.input);assert.deepEqual(result.output,row.expected);assert.deepEqual(result.input,row.input);}
  for(const row of W.executions(id,hidden))assert.deepEqual(sandbox.run(W.scenarioCode(row.input)),row.expected,id+' '+row.caseId);
 }
 const settlement=sandbox.run(W.scenarioCode(W.executions('E43')[0].input));
 assert.deepEqual(settlement.observations.map(r=>r.output.status),[201,200,403,403,409]);
 assert.deepEqual(settlement.observations[0].accounts.map(a=>a.balance),[0,1,50,50]);
 assert.equal(settlement.observations.at(-1).history.length,4);
 const reversed=sandbox.run(W.scenarioCode(W.executions('E44')[0].input));
 assert.deepEqual(reversed.observations.map(r=>r.output.status),[201,201,200,403,403]);
 assert.deepEqual(reversed.observations[1].accounts.map(a=>a.balance),[101,0,0,0]);
 assert.equal(reversed.observations.at(-1).history.length,8);
 const closed=sandbox.run(W.scenarioCode(W.executions('E45')[0].input));
 assert.equal(closed.observations[3].output.ready,true);assert.equal(closed.observations[3].history.length,9);
 assert.deepEqual(closed.observations[3].output.rollback.canonical,W.inputs('E43')[0].document);
 assert(closed.observations[3].accounts.every(a=>a.balance===0));
});
test('stateful workflow public verifiers execute every released plan and canonical scenario',()=>{
 const W=require('../benchmarks/ccv2-lhcb-02/fixture/workflows.cjs'),dir=reference();
 for(const [id] of W.specs){const r=cp.spawnSync(process.execPath,['--require',S.path.join(S.BENCH,'grader/offline.cjs'),S.path.join(dir,'tools/verify-workflows.cjs'),id],{encoding:'utf8'});assert.equal(r.status,0,id+': '+r.stdout+r.stderr);}
});
test('stateful workflow grader rejects fabricated writes and partial atomic publication',()=>{
 const W=require('../benchmarks/ccv2-lhcb-02/fixture/workflows.cjs'),P=require('../benchmarks/ccv2-lhcb-02/grader/workflow-probes.cjs'),dir=make(true),source=S.path.join(dir,'src/settlement.ts'),original=S.fs.readFileSync(source,'utf8');
 S.fs.appendFileSync(source,"\nmodule.exports.execute=()=>({status:201,postings:[],results:[],at:17});\n");
 let probes=P.grade(dir,['E43']);assert.equal(probes.probes.find(p=>p.id==='workflow-contract-settlement').pass,true);assert.equal(probes.probes.find(p=>p.id==='workflow-execution-settlement').pass,false);
 S.fs.writeFileSync(source,original);const batch=S.path.join(dir,'src/batch.ts');S.fs.writeFileSync(batch,L.reference('batch').replace('store.applyBatch(context.tenant,commands)',"commands.map(c=>require('./service.ts').post(store,{...c,tenant:context.tenant},actor,clock))"));
 assert.equal(P.grade(dir,['E43']).probes.find(p=>p.id==='workflow-execution-settlement').pass,false);
 S.fs.writeFileSync(batch,L.reference('batch'));const reversal=S.path.join(dir,'src/reversal.ts');S.fs.writeFileSync(reversal,W.reference('reversal').replace("if(!cached||cached.fingerprint!==JSON.stringify(x.receipt.postings[i]))return empty(409);","if(false)return empty(409);"));
 assert.equal(P.grade(dir,['E44']).probes.find(p=>p.id==='workflow-execution-reversal').pass,false);
});
test('stateful workflow replay returns detached copies of canonical commit identity',()=>{
 const W=require('../benchmarks/ccv2-lhcb-02/fixture/workflows.cjs'),sandbox=require('../benchmarks/ccv2-lhcb-02/grader/sandbox.cjs').create(reference()),row=W.executions('E43')[0].input;
 const r=sandbox.run(`const input=JSON.parse(${JSON.stringify(JSON.stringify(row))});const store=__load('persistence.ts').createStore(input.seed),a=input.actions[0],impl=__load('settlement.ts');impl.execute(store,a.input,a.actor,()=>17);const replay=impl.execute(store,a.input,a.actor,()=>23);replay.results[0].transactionId='forged';replay.postings[0].id='forged';return {cached:store.replay('alpha',JSON.stringify([a.input.key,0])).result,again:impl.execute(store,a.input,a.actor,()=>29),history:store.history()};`);
 assert.equal(r.cached.transactionId,'txn-1');assert.equal(r.again.results[0].transactionId,'txn-1');assert.equal(r.again.postings[0].id,'001');assert.equal(r.history.length,4);
});
test('stateful workload preserves byte-identical T00 and calibrated release artifacts',()=>{
 assert.deepEqual(C.phases().slice(0,7).map(id=>C.fingerprint(id).setHash),['48186b4d70332f687f06af9c6c6e4a6135e8cf0007ba93faeee69c2e837976ad','8466888ef29ca462c1b3260b4f87b957dd094c2da3d161d1d993a1b9280f565c','57e8af36afd761d4574aa22b2af0ca6f748a61121c0313db93d928818f94e7b1','c9acf67f8dacfbbb08e625d288ba9cc8f27125f81f1f0f5eb266f65842d90057','898a54821bc9ae4aa796ae9d92951737f8742e8885e896df9e88614517fe1a1d','260ef701df139d5fe1cc32ae0dd63fbd07ff103575294a9c0a757ba033f7e4aa','710ea7bd3c28a54389d6945f7d988f46709a0c3dd9c2f6ea26e3e25e30ef9555']);
});

test('canonical statement pages join live proofs and retain tenant cut across foreign writes',()=>{
 const P=require('../benchmarks/ccv2-lhcb-02/fixture/canonical-statements.cjs'),sandbox=require('../benchmarks/ccv2-lhcb-02/grader/sandbox.cjs').create(reference());
 for(const hidden of [false,true])for(const row of P.executions('E46',hidden))assert.deepEqual(sandbox.run(P.scenarioCode(row.input)),row.expected);
 const rows=P.executions('E46');const pages=rows[0].expected.observations.slice(4,7).flatMap(r=>r.output.entries);assert.deepEqual(pages.map(r=>r.key),['001','key/2','é']);assert.deepEqual(pages.map(r=>r.balance),[13,11,15]);
 const sequence=rows[1].expected.observations;assert.equal(sequence[6].output.status,200);assert.equal(sequence[8].output.status,409);assert.equal(sequence[9].output.account.balance,16);
 const denied=rows[2].expected.observations.slice(5);assert(denied.every(r=>r.output.status===403&&!r.accessed));
});
test('canonical statement pages positive verifier and independent withheld oracle agree',()=>{
 const dir=reference(),P=require('../benchmarks/ccv2-lhcb-02/fixture/canonical-statements.cjs');assert(require('../benchmarks/ccv2-lhcb-02/grader/statement-page-probes.cjs').grade(dir,['E46']).pass);
 const result=cp.spawnSync(process.execPath,['--require',S.path.join(S.BENCH,'grader/offline.cjs'),S.path.join(dir,'tools/verify-canonical-statements.cjs')],{encoding:'utf8'});assert.equal(result.status,0,result.stdout+result.stderr);
 const sandbox=require('../benchmarks/ccv2-lhcb-02/grader/sandbox.cjs').create(dir);for(const row of P.cases('E46',true))assert.deepEqual(sandbox.evaluate('canonical-statements',row.input).output,row.expected);
});
test('canonical statement pages reject caller shadow history, removed grants and foreign cut invalidation',()=>{
 const P=require('../benchmarks/ccv2-lhcb-02/fixture/canonical-statements.cjs'),dir=make(true),file=S.path.join(dir,'src/canonical-statements.ts'),probe=()=>require('../benchmarks/ccv2-lhcb-02/grader/statement-page-probes.cjs').grade(dir,['E46']);
 assert(probe().pass);
 const original=P.reference();
 S.fs.writeFileSync(file,original.replace('const result=evaluate({...input,records,current:store.read(input.tenant,input.account)});','const result=evaluate({...input,records:input.records||[],current:input.current||store.read(input.tenant,input.account)});'));assert.equal(probe().pass,false,'caller-supplied shadow history cannot substitute canonical records');
 S.fs.writeFileSync(file,original.replace("if(!require('./grants.ts').evaluate({actor,tenant:input.tenant,scope:'read',grant:input.grant}).allowed)",'if(false)'));assert.equal(probe().pass,false,'revoked and foreign reads must fail before store access');
 S.fs.writeFileSync(file,original.replace('store.history().filter(row=>row.tenant===input.tenant)','store.history()'));assert.equal(probe().pass,false,'foreign append must not invalidate tenant cursor');
 S.fs.writeFileSync(file,original.replace('const result=evaluate({...input,records,current:store.read(input.tenant,input.account)});',"if(records.length)records[0].replay.result.transactionId='changed';const result=evaluate({...input,records,current:store.read(input.tenant,input.account)});"));assert.equal(probe().pass,false,'canonical live replay receipts cannot be mutated');
 S.fs.writeFileSync(file,original);assert(probe().pass);
});
test('canonical statement page proof rejection and exact opaque identities have independent anchors',()=>{
 const P=require('../benchmarks/ccv2-lhcb-02/fixture/canonical-statements.cjs'),sandbox=require('../benchmarks/ccv2-lhcb-02/grader/sandbox.cjs').create(reference()),x=P.cases()[0].input;
 const result=sandbox.evaluate('canonical-statements',x).output;assert.deepEqual(result.entries,[{key:'001',posting:{id:'__proto__',amount:3,currency:'JPY',kind:'adjustment'},revision:1,balance:13,transactionId:'txn-1'}]);assert.equal(result.nextCursor,'["alpha","__proto__",["001","other","key/2","é"],1]');
 for(const mutate of [r=>r[0].journal.checksum='invalid',r=>r[0].replay=null,r=>r[0].replay.result.revision=99,r=>r[0].replay.fingerprint='{}']){const input=structuredClone(x);mutate(input.records);assert.equal(sandbox.evaluate('canonical-statements',input).output.status,409);}
 assert.equal(sandbox.evaluate('canonical-statements',{...x,cursor:JSON.stringify(['alpha','__proto__',['001'],1])}).output.status,409);
});

test('E05 authorized audit extension preserves every other earlier released artifact set',()=>{const frozen=[["T00","48186b4d70332f687f06af9c6c6e4a6135e8cf0007ba93faeee69c2e837976ad"],["E01","8466888ef29ca462c1b3260b4f87b957dd094c2da3d161d1d993a1b9280f565c"],["E02","57e8af36afd761d4574aa22b2af0ca6f748a61121c0313db93d928818f94e7b1"],["E03","c9acf67f8dacfbbb08e625d288ba9cc8f27125f81f1f0f5eb266f65842d90057"],["E04","898a54821bc9ae4aa796ae9d92951737f8742e8885e896df9e88614517fe1a1d"],["E05","260ef701df139d5fe1cc32ae0dd63fbd07ff103575294a9c0a757ba033f7e4aa"],["E06","710ea7bd3c28a54389d6945f7d988f46709a0c3dd9c2f6ea26e3e25e30ef9555"],["E07","84f7b7d0f54ea7dd1ab7217a76b06faf67e15f041aead74a3bbb6e05bc5bcc7d"],["E08","b27480e253d14961a63645b6ec7cb1dbc47a83861959f5431ed794233d2ac554"],["E09","c090ced0808af663f8ab8306d26db1fa9ac81d14868d782a3cd0727f218890de"],["E10","bac946e743410abea0e68270dfcfc451199f603d82bdb5e9a4d071dee3aa3b15"],["E11","b7c71429a4f8de615b844fbefa6a933504b8f4baa4fb2823a305e7981b9335ee"],["E12","cad29a7db875d92467f3b940b3d470a84acc38fabf152bde5107e4b8a6755b3f"],["E13","5301814bcb2976b55c0f032650c3f9e0a14bfd2be6bf02ee4cc04cee00a6bc28"],["E14","8176a3826d72a9578f1b62729cab35dfb1866e056bf945c8dea783539b355ee6"],["E15","9ad3677a5fd18c2c6c3283cf87ba19e727dc4dc7eae3a805c22c25737a0f8467"],["E16","a7c8c193e2616200976f7f8622a579416b9be285a879270cdae0e6e72e3916eb"],["E17","8ea4ce2ce67dc4f39d780a480c6619daff73986b7191ab7e5f5a27358fbedfba"],["E18","bae73a3938e710cfe107835b9c6470aebe2db7aa9130a759cdd4ec5814cbd756"],["E19","49e1cbde45b95f1008683caba7d7f033aa2af66fec5fbd2cd93a3b2fb72662ea"],["E20","ad1184139b4732fd5f7da32aa3b60521d669faaa84355efca6394b691b33b91a"],["E21","47a3d574f1f1722bab9be8b5ff977425e31bf89d894fcaaea0621ba850b7a58d"],["E22","0288fc00fa998a47021129403b30dafe601834ca8a924601cc45a175241e754d"],["E23","4787ec0c092b5c9241a66bfde3ab117ca2fc4d98120f8928f9422874c18ef2cf"],["E24","f1ba0832a7338da2bbf7e3e85b2804e49ee930edf60d3dd4d94c4819f7a2aaec"],["E25","dece4bfda3c6fb8b0db0b0f7245431bb36a1919f20ad8a6b58a11ce33b391679"],["E26","5f4cbf669d61fbc3f0b9a1354c87a5b9b280288c117b5aac8d87f0f29d9075be"],["E27","a2abdf2857af153c36562c07c608a332c725e28caa0a1d85aa9286c73eb07432"],["E28","388e8b7a1c129357d2a9e64e07149075d9070240c3e68e59144c3136fcdab052"],["E29","53aabe6bfdd4673f97c768bc9c580928b016d18c8634223ce35077d0d4b24f83"],["E30","9c4af26969a467d6d71790e89acd2a8532277e4a842f9141ab2abdd923fe8207"],["E31","c9bab4d565a1e523e68c9acc257c61a800cb8fe6cb6f499f98d69e7bd7db9bc4"],["E32","396444916cc5689b59271d30a0473d4443d759a92966cede91d35ed77b0a1ce7"],["E33","480de5d1ad9154106acce9be2920d7ca0d8e7991fe7c8166de9fbad30878617e"],["E34","9534aa8a7d12329e3100805d1e6410cfdb62f8284f645036d1150f1cab913e0b"],["E35","fb6e1e26f027d9d11d20eadf4073642c193a83109e6e618ee7e3f4f67e4fcecb"],["E36","dde55df6ae8a723f2a151ed81086c1dd4fef8a610a6f793eb3cbc320acf0651e"],["E37","3abdb02bfad5eaef53c4173bbc13fdf800f145c0e4176c6326ca47f65cee2427"],["E38","4def02fd4fd44d52d6613194e0188f6081ec6491bb3ab576a22cfda08c99a178"],["E39","840d6253dda397d3650a82112500f88e85acf65d71510c9781484e7d77d7d2e6"],["E40","cce54d56bd714032cc9a87c7154c2b65f8f5f4283d7f8f6bc5dd0a9828deb8c3"],["E41","3149d7128290ce4c1814d290f2dd318b6c119ab05983e0fb257306f48e54a828"],["E42","51efbb432dd21241842f3d6270121d874cd78ff491247e437b51eeca6ff7026c"],["E43","56206609ccfe0c80d3081de3953faa09e656bc255b3265fa9fc0ab9fd9608bc8"],["E44","b94470d064e30c88548f67bf583de1e3b1c0c46b3f76dc750b9e427503a594c4"],["E45","95f427be1cbec4ab4b5757000cd03a4f0eb31e966260b0c38996b39e1eddfd4e"],["T99","52306cdf0845ac25417b5587251e58c83b97f72010fc2ee2d4ab9e0ae6fc417a"]];for(const [id,hash] of frozen)assert.equal(C.fingerprint(id).setHash,hash,id);});
test('canonical statement pages malformed parsed posting is a conflict, never a thrown success path',()=>{
 const P=require('../benchmarks/ccv2-lhcb-02/fixture/canonical-statements.cjs'),sandbox=require('../benchmarks/ccv2-lhcb-02/grader/sandbox.cjs').create(reference()),x=P.cases()[0].input;
 for(const fingerprint of ['null','[]','7','"posting"']){const input=structuredClone(x);input.records[0].replay.fingerprint=fingerprint;assert.deepEqual(sandbox.evaluate('canonical-statements',input).output,{status:409,entries:[],nextCursor:null});}
 const input=structuredClone(x);input.records[0].journal=null;assert.equal(sandbox.evaluate('canonical-statements',input).output.status,409);
});


test('E05 audit caller records denied replay decisions without publishing ledger writes',()=>{
 const dir=reference(),sandbox=require('../benchmarks/ccv2-lhcb-02/grader/sandbox.cjs').create(dir);
 const result=sandbox.run(`const store=__load('persistence.ts').createStore(), audits=[];
 const caller=__load('service.ts'),adapter=__load('audited-service.ts');
 const command={tenant:'alpha',key:'audit-regression',expectedRevision:0,requestId:'r',posting:{id:'001',amount:7,currency:'JPY',kind:'transfer'}};
 const actor={tenant:'alpha',role:'writer',revoked:false,credential:'private'};
 const first=adapter.postAudited(store,command,actor,audits,()=>1);
 const denied=adapter.postAudited(store,command,{...actor,revoked:true},audits,()=>2);
 return {first,denied,audits,history:store.history()};`);
 assert.equal(result.first.status,201);assert.equal(result.denied.status,403);assert.equal(result.history.length,1);
 assert.deepEqual(result.audits,[{operation:'post',tenant:'alpha',decision:'allow',requestId:'r'},{operation:'post',tenant:'alpha',decision:'deny',requestId:'r'}]);
});


test('E05 audit boundary rejects released consumer defect and preserves all prior cases',()=>{
 const A=require('../benchmarks/ccv2-lhcb-02/fixture/audit-boundary.cjs'),dir=make(true),file=S.path.join(dir,'src/audited-service.ts');
 const run=()=>cp.spawnSync(process.execPath,['--require',S.path.join(S.BENCH,'grader/offline.cjs'),S.path.join(dir,'tools/verify-audit.cjs')],{encoding:'utf8'});
 assert.equal(run().status,0);assert.equal(require('../benchmarks/ccv2-lhcb-02/grader/probes.cjs').grade(dir,['E05']).pass,true);
 S.fs.writeFileSync(file,A.source);assert.equal(run().status,1);assert.equal(require('../benchmarks/ccv2-lhcb-02/grader/probes.cjs').grade(dir,['E05']).probes.find(p=>p.id==='audit-service-consistency').pass,false);
 S.fs.writeFileSync(file,A.reference);assert.equal(run().status,0);
 assert.equal(F.cases('E05').length,360);assert.equal(S.hash(S.json(F.cases('E05'))),'0ac0fd8b2c11a49a6a899852bed135f44913097dbcb47cfeaddb562ec309fdd3');
 const visible=new Set(A.inputs().map(S.json));assert(A.inputs(true).every(x=>!visible.has(S.json(x))));
});
test('E05 audit negative controls detect missing replay, false deny labels and input mutation',()=>{
 const A=require('../benchmarks/ccv2-lhcb-02/fixture/audit-boundary.cjs'),dir=make(true),file=S.path.join(dir,'src/audited-service.ts');
 for(const code of [A.reference.replace('audits.push(', 'if(result.status!==200)audits.push('),A.reference.replace('decision:access,requestId','decision:result.status===201?access:\'deny\',requestId'),A.reference.replace('return result;',"command.requestId='changed';return result;")]){
  S.fs.writeFileSync(file,code);const probes=require('../benchmarks/ccv2-lhcb-02/grader/probes.cjs').grade(dir,['E05']);assert.equal(probes.probes.find(p=>p.id==='audit-service-consistency').pass,false);
 }
 S.fs.writeFileSync(file,A.reference);assert.equal(require('../benchmarks/ccv2-lhcb-02/grader/probes.cjs').grade(dir,['E05']).pass,true);
});
