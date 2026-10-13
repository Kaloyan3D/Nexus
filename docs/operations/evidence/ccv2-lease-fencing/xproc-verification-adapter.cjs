'use strict';
// Existing cross-process suites, with ONLY fixture identity assignments omitted.
// The fixture repos inherit the user's configured Git identity. Assertions,
// production modules and synchronization in the suites are untouched.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Module = require('node:module');
const file = path.resolve(process.argv[2]);
let omitted = 0;
const code = fs.readFileSync(file, 'utf8').replace(/^\s*execFileSync\('git', \['-C', [^,\n]+, 'config', 'user\.(?:name|email)', '[^']*'\]\);\r?$/gm, () => { omitted++; return ''; });
assert.equal(omitted, 2, 'exactly two fixture identity assignments omitted');
console.log('Verification adapter: omitted 2 fixture Git identity assignments; all assertions unchanged.');
const entry = new Module(file);
entry.filename = file;
entry.paths = Module._nodeModulePaths(path.dirname(file));
process.mainModule = entry;
Module._cache[file] = entry;
entry._compile(code, file);
