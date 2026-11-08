'use strict';

const fs = require('node:fs');
const { parseSuites } = require('../../tests/lib/SuiteLane.cjs');

const lane = process.argv[2];
const source = fs.readFileSync(require.resolve('../../scripts/Test-Harness.ps1'), 'utf8');
const suites = parseSuites(source).filter(suite => suite.lane === lane);
if (!suites.length || new Set(suites.map(suite => suite.name)).size !== suites.length) {
  throw new Error('Expected a nonempty suite inventory with unique names');
}
console.log(JSON.stringify(suites));
