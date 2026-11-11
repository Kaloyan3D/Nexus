'use strict';

const fs = require('node:fs');
const { parseSuites } = require('../../tests/lib/SuiteLane.cjs');

const [lane, shard = 'full'] = process.argv.slice(2);
const source = fs.readFileSync(require.resolve('../../scripts/Test-Harness.ps1'), 'utf8');
const suites = parseSuites(source).filter(suite => suite.lane === lane);
if (!suites.length || new Set(suites.map(suite => suite.name)).size !== suites.length) {
  throw new Error('Expected a nonempty suite inventory with unique names');
}
let selected = suites;
if (shard !== 'full') {
  if (lane !== 'production' || !['general', 'boundary'].includes(shard)) throw new Error('Invalid production shard');
  const boundary = suites.filter(suite => suite.name === 'DeepSeekRequestBoundaryHost');
  if (boundary.length !== 1 || !boundary[0].completionMarker) throw new Error('Missing required boundary suite');
  selected = shard === 'boundary' ? boundary : suites.filter(suite => suite.name !== boundary[0].name);
  if (!selected.length) throw new Error('Expected a nonempty shard');
}
console.log(JSON.stringify(selected));
