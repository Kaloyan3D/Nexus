'use strict';
// Linux fixture installation proof, NOT native Windows certification.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {prepare}=require('../scripts/MusePresetDependencyClosure.cjs');
const source=path.resolve(__dirname,'..');
const area=fs.mkdtempSync(path.join(os.tmpdir(),'ccv2-restricted-install-'));
const pwsh=process.env.AIH_TEST_PWSH || (process.platform==='win32'?'powershell.exe':'pwsh');
let passed=0;
function check(ok,name){assert(ok,name);passed++;console.log('PASS: '+name);}
try {
  for(const name of ['config','scripts','tests','runtime']) fs.cpSync(path.join(source,name),path.join(area,name),{recursive:true});
  if(process.platform==='win32') throw Error('Native Windows installation requires the documented Windows gate; this fixture uses Linux symlinks.');
  fs.mkdirSync(path.join(area,'runtime/node/bin'),{recursive:true});
  fs.symlinkSync(process.execPath,path.join(area,'runtime/node/bin/node'));
  fs.symlinkSync(process.env.AIH_HOST_APP || '/home/kaloyan/.local/share/nexus/app',path.join(area,'app'),'dir');
  for(const profile of ['muse','controller','engineering','deepseek']) {
    const rows=prepare(source,area,{profile});
    check(rows.some(row=>row.name==='ContextDurableMutationPolicyV2.cjs') && rows.every(row=>!row.name.includes('ResearchRunner')),profile+' installed closure contains fixed guard and no research helper');
  }
  execFileSync(pwsh,['-NoProfile','-File',path.join(area,'scripts/Install-ControllerPresets.ps1'),'-InstallRoot',area],{stdio:'pipe',timeout:60000});
  execFileSync(process.execPath,[path.join(area,'tests/ControllerPresetInstalled.Tests.cjs'),area],{stdio:'pipe',timeout:60000});
  check(true,'actual installed controller compositions validate with the restricted dependency graph');
  const policy=require(path.join(area,'data/.agent-presets/aih-engineering/ContextDurableMutationPolicyV2.cjs'));
  check(!policy.durableMutationEnabledV2(),'installed controller policy remains disabled');
  assert.throws(()=>policy.assertDurableMutationAllowedV2(),e=>e.code==='ccv2-durable-mutation-disabled');
  check(true,'installed direct mutation authority refuses');
  // Execute the real harness dispatch/report code with three explicitly selected
  // suites in this private fixture, never claim that the full suite ran.
  const harness=path.join(area,'scripts/Test-Harness.ps1');
  let text=fs.readFileSync(harness,'utf8');
  text=text.replace('$started = [DateTime]::UtcNow',"$suites = @($suites | Where-Object { $_.name -in @('ContextRestrictedProductionV2','ContextRestrictedProjectionV2','ContextActiveApplyV2') })\n$started = [DateTime]::UtcNow");
  fs.writeFileSync(harness,text);
  const report=path.join(area,'subset-report.json');
  execFileSync(pwsh,['-NoProfile','-File',harness,'-InstallRoot',area,'-ReportPath',report],{stdio:'pipe',timeout:60000,env:{...process.env,AIH_TEST_PWSH:pwsh}});
  const result=JSON.parse(fs.readFileSync(report,'utf8'));
  check(result.suites.length===3 && result.suites.every(s=>s.result==='PASS'),'three-suite harness dispatch subset passes');
  check(result.suites.filter(s=>s.name.startsWith('ContextRestricted')).every(s=>s.verificationScope==='production'),'harness keeps production guard/projection proofs on shipped policy');
  check(result.suites.find(s=>s.name==='ContextActiveApplyV2').verificationScope==='research-only-active-algorithms','harness labels legacy active algorithm results as research only');
  check(result.ccv2DurableProductionStatus==='DISABLED_UNSAFE_FENCING_UNRESOLVED','harness report cannot imply active durable support');
} finally {fs.rmSync(area,{recursive:true,force:true});}
console.log('Restricted installation: passed='+passed+' failed=0 (Linux fixture only)');
