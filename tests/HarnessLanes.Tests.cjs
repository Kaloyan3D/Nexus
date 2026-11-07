'use strict'
// HarnessLanes.Tests.cjs — the production / ccv2-lab partition of scripts/Test-Harness.ps1.
//   node tests/HarnessLanes.Tests.cjs [--write-docs]
// Pins that: no suite is lost (lane totals add up to the table), every ContextRestricted* suite is
// production, the lab lane is purely CCv2 research suites, the PowerShell classifier uses the same
// rule as the JS one, the harness exposes -Lane with a printed lane summary (never silent), and
// docs/testing/CCV2-LAB-SUITES.md lists exactly the lab suites.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { suiteLane, parseSuites } = require('./lib/SuiteLane.cjs')
const root = path.join(__dirname, '..')
const harness = fs.readFileSync(path.join(root, 'scripts/Test-Harness.ps1'), 'utf8')
const suites = parseSuites(harness)
let passed = 0
const pass = (m) => { passed++; console.log('PASS: ' + m) }
const declared = (harness.match(/\[ordered\]@\{\s*name='/g) || []).length
assert.equal(suites.length, declared, 'every suite row must be parseable'); pass('all ' + declared + ' suite rows parse')
const lab = suites.filter((s) => s.lane === 'ccv2-lab'), prod = suites.filter((s) => s.lane === 'production')
assert.equal(lab.length + prod.length, suites.length); pass('lanes partition the table (production ' + prod.length + ' + ccv2-lab ' + lab.length + ' = ' + suites.length + ')')
assert.ok(suites.filter((s) => s.name.startsWith('ContextRestricted')).every((s) => s.lane === 'production') && prod.some((s) => s.name === 'ContextRestrictedDshCompaction')); pass('ContextRestricted* (the shipped restriction) are production')
assert.ok(lab.every((s) => /V2|R1RealSession|DeepseekV4/.test(s.name))); pass('lab lane contains only CCv2 research suites')
assert.ok(['ControllerRouting', 'SetupUpgrade', 'Harness', 'NexusControllerPanel', 'RuntimeRoutingTrace', 'NexusWorkspaceGuard', 'NexusComposerSeat'].every((n) => prod.some((s) => s.name === n))); pass('core product suites are production')
for (const token of ["-like 'ContextRestricted*'", "-match 'V2'", "'ContextR1RealSessionContracts'", "'ContextTokenizerDeepseekV4*'", "'ContextCompilerActiveDeepseekV4'", "ValidateSet('production','ccv2-lab','all')", 'HARNESS LANE:']) assert.ok(harness.includes(token), 'harness lacks ' + token)
pass('PowerShell classifier mirrors the JS rule and the lane summary is printed')
const names = (list) => list.map((s) => s.name)
const docPath = path.join(root, 'docs/testing/CCV2-LAB-SUITES.md')
const doc = ['# CCv2 laboratory suites (not installed behavior)', '',
  'These suites exercise CCv2 active/durable/projection machinery that the Nexus product keeps **disabled**',
  '(`ccv2-durable-mutation-disabled`; the DSH 0.2.2 persistence lease has no external fencing, see',
  '`docs/integration/dsh-0.2.x-migration-report.md`). They are research/laboratory coverage: nothing here ships',
  'enabled, and none of them is deleted, skipped or weakened. They remain runnable on an installed tree:', '',
  '```', 'pwsh scripts/Test-Harness.ps1 -Lane ccv2-lab -ContinueOnFailure -ReportPath <report.json>',
  'node tests/diagnostics/RunHarnessSuites.cjs <InstallRoot> <out.json> <tmpDir> --lane ccv2-lab', '```', '',
  'The production gate is `-Lane production`; `-Lane all` (the default) runs both. The shipped restriction itself is',
  'covered by the production `ContextRestricted*` suites. This list is generated and pinned by',
  '`tests/HarnessLanes.Tests.cjs --write-docs`.', '', '## Lab suites (' + lab.length + ')', '',
  ...lab.map((s) => '- `' + s.name + '` (' + s.kind + ', `' + s.script + '`)'), ''].join('\n')
if (process.argv.includes('--write-docs')) fs.writeFileSync(docPath, doc)
assert.equal(fs.readFileSync(docPath, 'utf8'), doc, 'docs/testing/CCV2-LAB-SUITES.md must match the lane table (run --write-docs)'); pass('lab suite documentation matches the table exactly')
console.log('SUITE RESULT: PASS ' + passed + ' | FAIL 0 | total ' + passed)
