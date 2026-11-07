'use strict'
// Single JS statement of the harness lane rule; scripts/Test-Harness.ps1 carries the same rule
// (Get-AihSuiteLane) and tests/HarnessLanes.Tests.cjs pins that the two agree.
function suiteLane(name) {
  if (/^ContextRestricted/.test(name)) return 'production'
  if (/V2/.test(name) || name === 'ContextR1RealSessionContracts' || /^ContextTokenizerDeepseekV4/.test(name) || name === 'ContextCompilerActiveDeepseekV4') return 'ccv2-lab'
  return 'production'
}
function parseSuites(harnessText) {
  const out = []
  for (const m of harnessText.matchAll(/\[ordered\]@\{\s*name='([^']+)';\s*script='([^']+)';[^}]*?kind='(node|powershell)'/g)) out.push({ name: m[1], script: m[2], kind: m[3], lane: suiteLane(m[1]) })
  return out
}
module.exports = { suiteLane, parseSuites }
