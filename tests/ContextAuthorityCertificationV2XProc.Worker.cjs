'use strict';
const fs = require('node:fs');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
const hostModule = require(path.join(repoRoot, 'config', 'ContextCompilerActiveOpencodeHostV2.cjs'));
const opencodeModule = require(path.join(repoRoot, 'config', 'ContextCompilerActiveOpencodeV2.cjs'));
function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
function main() {
  const out = arg('--out');
  const write = (value) => {
    fs.writeFileSync(out, JSON.stringify(value));
  };
  try {
    const storeRoot = arg('--store');
    const identityFile = arg('--identity');
    const identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
    const started = hostModule.startupOpencodeAuthorityV2({ storeRoot, expectedIdentity: identity });
    const health = opencodeModule.opencodeHealthV2({ provider: 'opencode-go', model: 'muse-spark-1.3-contributor' });
    write({ ok: true, state: started.state, health, hasCertification: started.certification !== null });
  } catch (error) {
    try {
      write({ ok: false, error: String((error && error.message) || error).slice(0, 200) });
    } catch (ignored) {
      void ignored;
    }
  }
}
main();
