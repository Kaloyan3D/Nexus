// The package-content test must itself be trustworthy: it passes a complete synthetic package and FAILS, naming
// the problem, when any required asset is removed or corrupted.   node --test packaging/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PIN, PROGRAMS, verifyTree } from './verify-package.mjs'

const CONTROL = `Package: nexus
Version: 0.1.0
Architecture: amd64
Depends: libc6 (>= 2.39), libwebkit2gtk-4.1-0, libgtk-3-0, bubblewrap, systemd, util-linux, zenity | kdialog
`
const ELF = fs.readFileSync('/bin/true') // any x86-64 ELF will do for the shape checks
const isX86Elf = ELF.subarray(0, 4).toString('latin1') === '\x7fELF' && ELF.readUInt16LE(18) === 0x3e

function tree() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nxvt-'))
  const w = (rel, content, mode = 0o644) => {
    const f = path.join(d, rel)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, content, { mode })
    fs.chmodSync(f, mode)
  }
  w('usr/bin/nexus-desktop', ELF, 0o755)
  for (const p of PROGRAMS) w(`usr/lib/Nexus/bin/${p}`, ELF, 0o755)
  const L = 'usr/lib/Nexus/node'
  w(`${L}/bin/node`, ELF, 0o755)
  w(`${L}/bin/npm`, '#!/bin/sh\n', 0o755)
  w(`${L}/bin/npx`, '#!/bin/sh\n', 0o755)
  w(`${L}/LICENSE`, 'Node.js is licensed for use as follows:\n')
  w(`${L}/lib/node_modules/npm/package.json`, '{}')
  w(`${L}/lib/node_modules/npm/bin/npm-cli.js`, '')
  w(`${L}/lib/node_modules/npm/bin/npx-cli.js`, '')
  w(`${L}/nexus-node.json`, JSON.stringify({ schemaVersion: 1, version: PIN.version, arch: PIN.arch, nodeSha256: createHash('sha256').update(ELF).digest('hex'), archiveSha256: PIN.sha256 }))
  const R = 'usr/lib/Nexus/repo'
  w(`${R}/config/registry/native-intent-bridge.cjs`, "const a = require('./service.cjs')\n")
  w(`${R}/config/registry/service.cjs`, '')
  w(`${R}/scripts/Setup-NativeOpenCodeGo.cjs`, "require(path.join(REPO, 'config', 'registry', 'service.cjs'))\n")
  w(`${R}/scripts/Verify-NativeOpenCodeGoRoute.cjs`, "require(path.join(REPO, 'config', 'registry', 'service.cjs'))\n")
  for (const m of ['engineering-v1', 'engineering-v2', 'engineering-v2-jobs', 'engineering-v3', 'engineering-v2-adaptive']) w(`${R}/config/registry/modes/${m}.json`, '{}')
  w('usr/share/doc/nexus/THIRD-PARTY-NOTICES.md', `Node.js ${PIN.version}\nNode.js is licensed for use as follows:\n`)
  w('usr/share/applications/Nexus.desktop', '[Desktop Entry]\n')
  w('usr/share/icons/hicolor/512x512/apps/nexus-desktop.png', 'x')
  return d
}
const run = (d, control = CONTROL) => verifyTree(d, control, { runNode: false })

test('a complete package passes', { skip: !isX86Elf }, () => {
  assert.deepEqual(run(tree()), [])
})

test('every required asset, when removed, is reported by name', { skip: !isX86Elf }, () => {
  const rm = (rel) => {
    const d = tree()
    fs.rmSync(path.join(d, rel), { recursive: true, force: true })
    return run(d)
  }
  for (const [rel, expect] of [
    ['usr/bin/nexus-desktop', 'usr/bin/nexus-desktop'],
    ['usr/lib/Nexus/bin/nexusd', 'program nexusd'],
    ['usr/lib/Nexus/bin/nexus-confine', 'program nexus-confine'],
    ['usr/lib/Nexus/node/bin/node', 'node/bin/node'],
    ['usr/lib/Nexus/node/bin/npm', 'node/bin/npm'],
    ['usr/lib/Nexus/node/nexus-node.json', 'nexus-node.json'],
    ['usr/lib/Nexus/node/LICENSE', 'node/LICENSE'],
    ['usr/lib/Nexus/node/lib/node_modules/npm/package.json', 'npm/package.json'],
    ['usr/lib/Nexus/repo/config/registry/native-intent-bridge.cjs', 'native-intent-bridge.cjs'],
    ['usr/lib/Nexus/repo/config/registry/service.cjs', 'service.cjs'], // required BY the bridge and the scripts
    ['usr/lib/Nexus/repo/scripts/Setup-NativeOpenCodeGo.cjs', 'Setup-NativeOpenCodeGo.cjs'],
    ['usr/lib/Nexus/repo/scripts/Verify-NativeOpenCodeGoRoute.cjs', 'Verify-NativeOpenCodeGoRoute.cjs'],
    ['usr/lib/Nexus/repo/config/registry/modes/engineering-v2-adaptive.json', 'engineering-v2-adaptive'],
    ['usr/lib/Nexus/repo/config/registry/modes', 'modes'],
    ['usr/share/doc/nexus/THIRD-PARTY-NOTICES.md', 'notices'],
    ['usr/share/applications/Nexus.desktop', '.desktop'],
  ]) {
    const bad = rm(rel)
    assert.ok(bad.some((b) => b.includes(expect)), `${rel}: expected a problem naming "${expect}", got ${JSON.stringify(bad)}`)
  }
})

test('a corrupted, wrong or unsafe Node.js is refused', { skip: !isX86Elf }, () => {
  let d = tree()
  fs.appendFileSync(path.join(d, 'usr/lib/Nexus/node/bin/node'), 'x')
  assert.ok(run(d).some((b) => b.includes('SHA-256 does not match')))
  d = tree()
  const m = path.join(d, 'usr/lib/Nexus/node/nexus-node.json')
  fs.writeFileSync(m, fs.readFileSync(m, 'utf8').replace(PIN.version, 'v22.0.0'))
  assert.ok(run(d).some((b) => b.includes('!= pinned')))
  d = tree()
  fs.chmodSync(path.join(d, 'usr/lib/Nexus/node/bin/node'), 0o777)
  assert.ok(run(d).some((b) => b.includes('writable by group/others')))
  d = tree()
  fs.writeFileSync(path.join(d, 'usr/lib/Nexus/node/bin/node'), '#!/bin/sh\n', { mode: 0o755 })
  assert.ok(run(d).some((b) => b.includes('not an x86-64 ELF')))
})

test('the control file must declare the runtime needs and must not depend on a system Node.js', { skip: !isX86Elf }, () => {
  const d = tree()
  assert.ok(run(d, CONTROL.replace('libc6 (>= 2.39), ', '')).some((b) => b.includes('libc6')))
  assert.ok(run(d, CONTROL.replace('bubblewrap, ', '')).some((b) => b.includes('bubblewrap')))
  assert.ok(run(d, CONTROL.replace('zenity | kdialog', 'zenity')).some((b) => b.includes('zenity | kdialog')))
  assert.ok(run(d, CONTROL.replace('util-linux', 'util-linux, nodejs (>= 18)')).some((b) => b.includes('system Node.js')))
  assert.ok(run(d, CONTROL.replace('amd64', 'arm64')).some((b) => b.includes('Architecture')))
})
