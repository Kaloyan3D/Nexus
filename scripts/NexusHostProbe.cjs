'use strict'

// NexusHostProbe.cjs — ask whether a Nexus host owns this installation.
//
//   node scripts/NexusHostProbe.cjs <DataRoot> [AppRoot]
//
// Prints one JSON line: { state, holder } where state is
//   free         no host holds the installation lock (the probe acquired and
//                released it immediately, within microseconds);
//   owned        a live host holds the kernel lock (holder = its informational
//                descriptor: pid, generation, build);
//   unavailable  the lock mechanism could not be used (reason).
// Never steals, never blocks, never deletes files. Exit code 0 in every case;
// callers decide. A starting host retries its own acquisition briefly, so a
// probe can never permanently displace it.

const path = require('node:path')
const ownership = require(path.join(__dirname, '..', 'config', 'nexus', 'host-ownership.cjs'))

async function main() {
  const dataRoot = process.argv[2]
  if (!dataRoot) { process.stdout.write(JSON.stringify({ state: 'unavailable', reason: 'usage: NexusHostProbe.cjs <DataRoot> [AppRoot]' }) + '\n'); return }
  const appRoot = process.argv[3] || path.join(path.resolve(dataRoot), '..', 'app')
  const result = await ownership.acquireHostOwnership({ dataRoot, appRoot, build: 'probe' })
  if (result.state === 'held') {
    // A probe must not leave a descriptor behind: release removes its own.
    await result.release()
    process.stdout.write(JSON.stringify({ state: 'free', dataRoot: result.dataRoot }) + '\n')
    return
  }
  if (result.state === 'contended') {
    process.stdout.write(JSON.stringify({ state: 'owned', dataRoot: result.dataRoot, holder: result.holder || null }) + '\n')
    return
  }
  process.stdout.write(JSON.stringify({ state: 'unavailable', reason: result.reason || 'unknown' }) + '\n')
}

main().catch((error) => { process.stdout.write(JSON.stringify({ state: 'unavailable', reason: String(error && error.message ? error.message : error) }) + '\n') })
