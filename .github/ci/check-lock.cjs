'use strict';

const assert = require('node:assert/strict');
const manifest = require('../../runtime/package.json');
const lock = require('../../runtime/package-lock.json');
const versions = require('../../config/versions.json');

assert.equal(lock.lockfileVersion, 3);
assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
for (const [name, version] of Object.entries({
  '@deepseek-ai/dsh': versions.HarnessVersion,
  '@deepseek-ai/dsh-session-persistence': versions.HarnessVersion,
  '@deepseek-ai/dsh-subagent-codex': versions.CodexSubagentVersion,
  'openai-oauth': versions.OpenAiOAuthVersion,
})) {
  assert.equal(manifest.dependencies[name], version, name);
}

const installScripts = new Set();
for (const [location, pkg] of Object.entries(lock.packages)) {
  if (location === '') continue;
  const name = location.split('node_modules/').at(-1);
  const source = new URL(pkg.resolved);
  assert.equal(source.origin, 'https://registry.npmjs.org', location);
  assert.equal(source.username + source.password, '', location);
  assert.match(pkg.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, location);
  if (pkg.hasInstallScript) installScripts.add(`${name}@${pkg.version}`);
}
for (const [name, version] of Object.entries(manifest.dependencies)) {
  assert.equal(lock.packages[`node_modules/${name}`].version, version, name);
}
assert.deepEqual(manifest.allowScripts, Object.fromEntries([...installScripts].map(name => [name, true])));
console.log(`Verified integrity and lifecycle policy for ${Object.keys(lock.packages).length - 1} locked packages.`);
