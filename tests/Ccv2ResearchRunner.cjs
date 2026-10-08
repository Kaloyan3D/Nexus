'use strict';
// Explicit laboratory for retained, unfinished CCv2 algorithms. Production
// modules NEVER import this file. It changes policy only in a private copied
// checkout, not the shipped module, env, caller process or installed runtime.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const RESEARCH_SUITES = Object.freeze([
  'ContextCheckpointV2.Tests.cjs', 'ContextTrustV2.Tests.cjs', 'ContextSnapshotV2.Tests.cjs',
  'ContextCheckpointabilityV2.Tests.cjs', 'ContextCheckpointabilityV2LiveHost.Tests.cjs',
  'ContextShadowV2.Tests.cjs', 'ContextShadowV2LiveHost.Tests.cjs',
  'ContextCompactionV2Operation.Tests.cjs', 'ContextCompactionV2FoundationHardening.Tests.cjs',
  'ContextCompactionV2.Tests.ps1', 'ContextActiveApplyV2.Tests.cjs', 'ContextActiveApplyV2LiveHost.Tests.cjs',
  'ContextActiveApplyV2XProc.Tests.cjs', 'ContextGenerationRuntimeV2.Tests.cjs',
  'ContextGenerationRuntimeV2LiveHost.Tests.cjs', 'ContextGenerationRuntimeV2XProc.Tests.cjs',
  'ContextRecoveryV2.Tests.cjs', 'ContextRecoveryV2LiveHost.Tests.cjs', 'ContextRecoveryV2XProc.Tests.cjs',
  'ContextCompleteTaskV2.Tests.cjs', 'ContextCompleteTaskV2LiveHost.Tests.cjs', 'ContextCompleteTaskV2XProc.Tests.cjs',
  'ContextCompilerShadowHostV2.Tests.cjs', 'ContextCompilerActiveHostV2.Tests.cjs',
  'ContextCompilerActiveDeepseekV4.Tests.cjs', 'ContextCompilerActiveMuseRoutesV2.Tests.cjs',
  'ContextCompilerActiveOpencodeHostV2.Tests.cjs', 'ContextMemoryProducerV2.Tests.cjs',
  'ContextLeaseFencing.Tests.cjs', 'diagnostics/ShortLeaseOwnership.cjs',
]);
function createLaboratory() {
  const area = fs.mkdtempSync(path.join(os.tmpdir(), 'ccv2-research-only-'));
  for (const name of ['config', 'scripts', 'tests', 'runtime', 'docs/architecture']) {
    const source = path.join(root, name);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(area, name), {
      recursive: true, filter: file => !file.split(path.sep).includes('node_modules'),
    });
  }
  // Fixed policy replacement is private test data. It cannot be selected by
  // production env/config flags and is never copied back into the repository.
  fs.writeFileSync(path.join(area, 'config/ContextDurableMutationPolicyV2.cjs'), `
'use strict';
module.exports = Object.freeze({ DURABLE_MUTATION_DISABLED_CODE: 'ccv2-durable-mutation-disabled', durableMutationEnabledV2() { return true; }, assertDurableMutationAllowedV2() {} });
`);
  const lifecycle = path.join(area, 'scripts/ContextLifecycle.ps1');
  let script = fs.readFileSync(lifecycle, 'utf8');
  const refusal = "    throw 'ccv2-durable-mutation-disabled: active durable CCv2 is unavailable until mutation-time fencing is verified'";
  assert(script.includes(refusal), 'exact production PowerShell restriction is present');
  script = script.replace(refusal, '    # Research-only fixture; production source remains disabled.');
  fs.writeFileSync(lifecycle, script);
  // Existing fixture identity assignments are omitted, never applied. Fixture
  // repositories inherit the user's configured identity; assertions are intact.
  let omittedIdentityAssignments = 0;
  for (const entry of fs.readdirSync(path.join(area, 'tests'))) {
    if (!/\.(cjs|ps1)$/.test(entry)) continue;
    const file = path.join(area, 'tests', entry);
    const source = fs.readFileSync(file, 'utf8');
    let adapted = source.replace(/^\s*execFileSync\('git', \['-C', [^,\n]+, 'config', 'user\.(?:name|email)', '[^']*'\]\);\r?$/gm, () => { omittedIdentityAssignments++; return ''; });
    adapted = adapted.replace(/& git -C \$path config user\.(?:name|email) [^;\r\n]+\| Out-Null; /g, () => { omittedIdentityAssignments++; return ''; });
    if (adapted !== source) fs.writeFileSync(file, adapted);
  }
  execFileSync('git', ['init', '-q', area]);
  execFileSync('git', ['-C', area, 'add', 'config']);
  for (const key of ['user.name', 'user.email']) {
    const expected = execFileSync('git', ['-C', root, 'config', key], { encoding: 'utf8' }).trim();
    assert.equal(execFileSync('git', ['-C', area, 'config', key], { encoding: 'utf8' }).trim(), expected, 'fixture inherits user-owned identity');
  }
  execFileSync('git', ['-C', area, 'commit', '-qm', 'Synthetic CCv2 research fixture']);
  return { area, omittedIdentityAssignments };
}
function runResearchSuite(relative, extra = []) {
  assert(RESEARCH_SUITES.includes(relative), 'only named research suites may use this laboratory');
  const lab = createLaboratory();
  console.log('RESEARCH ONLY: private copied checkout; unfinished active algorithms, NOT production support.');
  console.log('Fixture Git identity assignments omitted: ' + lab.omittedIdentityAssignments);
  try {
    const script = path.join(lab.area, 'tests', relative);
    const executable = relative.endsWith('.ps1') ? (process.env.AIH_TEST_PWSH || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh')) : process.execPath;
    const args = relative.endsWith('.ps1') ? ['-NoProfile', '-File', script, '-InstallRoot', lab.area] : [script];
    if (relative === 'diagnostics/ShortLeaseOwnership.cjs') args.push(lab.area);
    args.push(...extra);
    const result = spawnSync(executable, args, { cwd: lab.area, env: process.env, stdio: 'inherit', timeout: 300000 });
    if (result.error) throw result.error;
    return result.status === null ? 2 : result.status;
  } finally { fs.rmSync(lab.area, { recursive: true, force: true }); }
}
if (require.main === module) {
  try {
    if (process.argv[2] === '--list') console.log(JSON.stringify(RESEARCH_SUITES));
    else process.exitCode = runResearchSuite(process.argv[2], process.argv.slice(3));
  }
  catch (error) { console.error(error.stack); process.exitCode = 2; }
}
module.exports = Object.freeze({ RESEARCH_SUITES, createLaboratory, runResearchSuite });
