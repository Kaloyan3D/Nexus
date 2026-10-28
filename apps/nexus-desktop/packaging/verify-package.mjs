#!/usr/bin/env node
// Package-content release test: fails (exit 1) if the .deb lacks anything Nexus needs to run on a clean machine
// with no system Node.js, or ships something it must not.
//
//   node packaging/verify-package.mjs path/to/Nexus_x.y.z_amd64.deb
//
// What it proves about the PACKAGE (it does not replace installing and running it):
//   - every program, the private Node.js, the Registry bridge (and the files its scripts require), the provider
//     scripts, the mode definitions, the notices, the launcher and the icon are present, with the right modes;
//   - every program is an x86-64 ELF and none needs a newer glibc than the package declares;
//   - the private Node.js matches the pinned manifest (version, architecture, SHA-256) and runs;
//   - the control file declares what the runtime needs from the system (glibc, bubblewrap, systemd, a dialog tool)
//     and does NOT depend on a system Node.js.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
export const PIN = JSON.parse(fs.readFileSync(path.join(here, 'node-runtime.json'), 'utf8'))
const LIB = 'usr/lib/Nexus'
/** Files the Registry bridge READS at run time (not require()d, so no static scan finds them). */
export const BRIDGE_DATA = ['config/model-registry.json', 'config/engineering-profiles.json', 'config/muse-profiles.json']
export const PROGRAMS = ['nexusd', 'nexus-broker', 'nexus-approver', 'nexus-confine', 'nexus-egress']

const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const isElf64 = (f) => {
  const h = fs.readFileSync(f).subarray(0, 20)
  return h.subarray(0, 4).toString('latin1') === '\x7fELF' && h[4] === 2 && h[5] === 1 && h.readUInt16LE(18) === 0x3e
}

/** Highest GLIBC_x.y symbol version a binary needs (null = none). */
export function glibcFloor(f) {
  let out = ''
  try {
    out = execFileSync('objdump', ['-T', f], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }).toString()
  } catch {
    return null
  }
  const v = [...out.matchAll(/GLIBC_(\d+)\.(\d+)(?:\.(\d+))?/g)].map((m) => [+m[1], +m[2], +(m[3] ?? 0)])
  v.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
  return v.length ? v[v.length - 1].join('.') : null
}
const cmpVer = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

/** Files a script or module of the bridge pulls in, by relative './x.cjs' and path.join(REPO, ...) requires. */
function requiredFiles(root, rel) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8')
  const out = new Set()
  for (const m of text.matchAll(/require\(\s*'(\.[^']+)'\s*\)/g)) out.add(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])))
  for (const m of text.matchAll(/require\(\s*path\.join\(\s*REPO\s*,\s*((?:'[^']+'\s*,?\s*)+)\)\s*\)/g)) {
    out.add([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).join('/'))
  }
  return [...out]
}

/**
 * Verify an EXTRACTED package: `data` is the root of data.tar, `control` the text of the control file.
 * Returns a list of problems (empty = pass). `runNode` also executes the private node (off in unit tests).
 */
export function verifyTree(data, control, { runNode = true } = {}) {
  const bad = []
  const need = (rel, what = rel) => {
    const f = path.join(data, rel)
    if (!fs.existsSync(f)) {
      bad.push(`missing: ${what}`)
      return null
    }
    return f
  }
  const mode = (rel, want) => {
    const f = path.join(data, rel)
    if (!fs.existsSync(f)) return
    const m = fs.statSync(f).mode & 0o777
    if (m !== want) bad.push(`${rel}: mode ${m.toString(8)}, expected ${want.toString(8)}`)
    if (fs.statSync(f).mode & 0o022) bad.push(`${rel}: writable by group/others`)
  }

  const depends = (control.match(/^Depends:\s*(.*)$/m) ?? [, ''])[1]
  const libc = depends.match(/libc6 \(>= ([0-9.]+)\)/)
  if (!libc) bad.push('control: Depends lacks `libc6 (>= X)`')
  for (const d of ['bubblewrap', 'systemd', 'util-linux', 'libwebkit2gtk-4.1-0', 'libgtk-3-0']) if (!depends.includes(d)) bad.push(`control: Depends lacks ${d}`)
  if (!/zenity \| kdialog/.test(depends)) bad.push('control: Depends lacks `zenity | kdialog` (the native dialogs)')
  if (/\bnodejs\b/.test(depends)) bad.push('control: depends on a system Node.js (Nexus must bring its own)')
  if (!/^Architecture:\s*amd64\s*$/m.test(control)) bad.push('control: Architecture is not amd64')

  const exe = need('usr/bin/nexus-desktop', 'the application (usr/bin/nexus-desktop)')
  const elfs = []
  if (exe) elfs.push(exe)
  for (const p of PROGRAMS) {
    const f = need(`${LIB}/bin/${p}`, `program ${p}`)
    if (f) elfs.push(f)
    mode(`${LIB}/bin/${p}`, 0o755)
  }
  for (const f of elfs) {
    if (!isElf64(f)) bad.push(`${path.relative(data, f)}: not an x86-64 ELF`)
    const fl = glibcFloor(f)
    if (fl && libc && cmpVer(fl, libc[1]) > 0) bad.push(`${path.relative(data, f)}: needs glibc ${fl}, package declares >= ${libc[1]}`)
  }

  // the private Node.js
  const nd = `${LIB}/node`
  const man = need(`${nd}/nexus-node.json`, 'node manifest nexus-node.json')
  for (const f of ['bin/node', 'bin/npm', 'bin/npx', 'LICENSE', 'lib/node_modules/npm/package.json', 'lib/node_modules/npm/bin/npm-cli.js', 'lib/node_modules/npm/bin/npx-cli.js']) need(`${nd}/${f}`, `node/${f}`)
  mode(`${nd}/bin/node`, 0o755)
  mode(`${nd}/bin/npm`, 0o755)
  mode(`${nd}/bin/npx`, 0o755)
  const node = path.join(data, nd, 'bin/node')
  if (man && fs.existsSync(node)) {
    const m = JSON.parse(fs.readFileSync(man, 'utf8'))
    if (m.version !== PIN.version) bad.push(`node: manifest version ${m.version} != pinned ${PIN.version}`)
    if (m.arch !== PIN.arch) bad.push(`node: manifest arch ${m.arch} != ${PIN.arch}`)
    if (m.archiveSha256 && m.archiveSha256 !== PIN.sha256) bad.push('node: archive digest in manifest != pinned digest')
    if (!isElf64(node)) bad.push('node/bin/node: not an x86-64 ELF')
    if (sha(node) !== m.nodeSha256) bad.push('node/bin/node: SHA-256 does not match nexus-node.json')
    if (runNode) {
      try {
        const v = execFileSync(node, ['--version'], { env: {} }).toString().trim()
        if (v !== PIN.version) bad.push(`node: runs as ${v}, pinned ${PIN.version}`)
      } catch (e) {
        bad.push(`node: does not run (${e.message.split('\n')[0]})`)
      }
    }
  }
  if (fs.existsSync(path.join(data, nd, 'LICENSE')) && !/Node\.js is licensed for use as follows/.test(fs.readFileSync(path.join(data, nd, 'LICENSE'), 'utf8'))) bad.push('node/LICENSE is not the Node.js license')

  // the Registry bridge and the scripts the runtime launches, with everything they require
  const repo = `${LIB}/repo`
  const entries = ['config/registry/native-intent-bridge.cjs', 'scripts/Setup-NativeOpenCodeGo.cjs', 'scripts/Verify-NativeOpenCodeGoRoute.cjs', ...BRIDGE_DATA]
  const seen = new Set()
  const queue = [...entries]
  while (queue.length) {
    const rel = queue.pop()
    if (seen.has(rel)) continue
    seen.add(rel)
    if (!need(`${repo}/${rel}`, `repo/${rel}`)) continue
    if (rel.endsWith('.cjs')) for (const r of requiredFiles(path.join(data, repo), rel)) queue.push(r)
  }
  const modes = path.join(data, repo, 'config/registry/modes')
  if (!fs.existsSync(modes) || fs.readdirSync(modes).filter((f) => f.endsWith('.json')).length < 5) bad.push('repo/config/registry/modes: engineering mode definitions missing (need >= 5)')
  if (!fs.existsSync(path.join(data, repo, 'config/registry/modes/engineering-v2-adaptive.json'))) bad.push('repo/config/registry/modes/engineering-v2-adaptive.json missing (Nexus Adaptive)')

  if (runNode && fs.existsSync(path.join(data, nd, 'bin/node')) && fs.existsSync(path.join(data, repo, 'config/registry/native-intent-bridge.cjs'))) {
    bad.push(...bridgeSelfTest(path.join(data, repo), path.join(data, nd, 'bin/node')))
  }
  need('usr/share/doc/nexus/THIRD-PARTY-NOTICES.md', 'third-party notices')
  const notices = path.join(data, 'usr/share/doc/nexus/THIRD-PARTY-NOTICES.md')
  if (fs.existsSync(notices)) {
    const t = fs.readFileSync(notices, 'utf8')
    if (!t.includes(PIN.version) || !t.includes('Node.js is licensed for use as follows')) bad.push('notices: Node.js version/license text missing')
  }
  const desktop = fs.existsSync(path.join(data, 'usr/share/applications')) ? fs.readdirSync(path.join(data, 'usr/share/applications')).filter((f) => f.endsWith('.desktop')) : []
  if (desktop.length === 0) bad.push('missing: .desktop launcher')
  if (!fs.existsSync(path.join(data, 'usr/share/icons'))) bad.push('missing: application icon')
  return bad
}

/**
 * Execute the packaged bridge with the packaged Node against a throw-away data directory: provider setup (no
 * network, no key), then the catalog. A file the bridge needs but the package lacks fails HERE, not on a customer's
 * first launch. Returns problems.
 */
export function bridgeSelfTest(repoDir, nodeBin) {
  const bad = []
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'nxbridge-'))
  try {
    const run = (args) => execFileSync(nodeBin, args, { cwd: repoDir, env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).toString()
    try {
      run([path.join(repoDir, 'scripts/Setup-NativeOpenCodeGo.cjs'), '--data-root', data, '--apply'])
    } catch (e) {
      bad.push(`bridge self-test: provider setup script failed (${(e.stderr?.toString() || e.message).split('\n')[0]})`)
      return bad
    }
    try {
      const out = JSON.parse(run([path.join(repoDir, 'config/registry/native-intent-bridge.cjs'), 'catalog', repoDir, data]))
      if (out.ok !== true || !Array.isArray(out.targets) || out.targets.length === 0) bad.push(`bridge self-test: catalog is not ok (${JSON.stringify(out).slice(0, 160)})`)
    } catch (e) {
      bad.push(`bridge self-test: the bridge failed (${(e.stderr?.toString() || e.message).split('\n')[0]})`)
    }
  } finally {
    fs.rmSync(data, { recursive: true, force: true })
  }
  return bad
}

/** Extract a .deb into a temp directory (needs `ar` and `tar`). */
export function extractDeb(deb) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'nxpkg-'))
  const ar = path.join(t, 'ar')
  fs.mkdirSync(ar)
  execFileSync('ar', ['x', path.resolve(deb)], { cwd: ar })
  const find = (p) => fs.readdirSync(ar).find((f) => f.startsWith(p))
  const data = path.join(t, 'data')
  const ctl = path.join(t, 'control')
  fs.mkdirSync(data)
  fs.mkdirSync(ctl)
  execFileSync('tar', ['-xf', path.join(ar, find('data.tar'))], { cwd: data })
  execFileSync('tar', ['-xf', path.join(ar, find('control.tar'))], { cwd: ctl })
  return { dir: t, data, control: fs.readFileSync(path.join(ctl, 'control'), 'utf8') }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const deb = process.argv[2]
  if (!deb || !fs.existsSync(deb)) {
    console.error('usage: verify-package.mjs <package.deb>')
    process.exit(2)
  }
  const { dir, data, control } = extractDeb(deb)
  try {
    const bad = verifyTree(data, control)
    const size = (fs.statSync(deb).size / 1048576).toFixed(1)
    if (bad.length) {
      console.error(`PACKAGE VERIFICATION FAILED (${path.basename(deb)}):`)
      for (const b of bad) console.error('  - ' + b)
      process.exit(1)
    }
    console.log(`package ok: ${path.basename(deb)} (${size} MiB), sha256 ${sha(deb)}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
