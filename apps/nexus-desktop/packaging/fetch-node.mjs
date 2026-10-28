#!/usr/bin/env node
// Stage the private Node.js runtime for the package.
//
//   node packaging/fetch-node.mjs [--cache DIR] [--verify-signature]
//
// 1. the archive named in node-runtime.json is downloaded (or taken from the cache);
// 2. its SHA-256 must equal the PINNED digest in node-runtime.json AND the one in nodejs.org's SHASUMS256.txt;
//    with --verify-signature the SHASUMS256.txt signature is checked with gpg against the pinned signer fingerprint;
// 3. it is unpacked and trimmed to what Nexus needs (bin/node, npm, LICENSE), the binary must be an x86-64 ELF and
//    `node --version` must equal the pinned version;
// 4. src-tauri/resources/node/ is (re)written with nexus-node.json, which the runtime re-checks at every start.
// Anything wrong aborts with a non-zero exit: a package is never built from an unverified runtime.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
const pin = JSON.parse(fs.readFileSync(path.join(here, 'node-runtime.json'), 'utf8'))
const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d)
const cache = opt('--cache', path.join(os.homedir(), '.cache', 'nexus-packaging'))
const out = path.resolve(here, '..', 'src-tauri', 'resources', 'node')
const die = (m) => {
  console.error(`fetch-node: ${m}`)
  process.exit(1)
}
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex')

fs.mkdirSync(cache, { recursive: true })
const archive = path.join(cache, pin.archive)
const download = (url, dest) => execFileSync('curl', ['-sSf', '--retry', '3', '-o', dest, url], { stdio: 'inherit' })
if (!fs.existsSync(archive)) download(pin.url, archive)
if (sha(archive) !== pin.sha256) die(`${pin.archive} does not match the pinned digest (${sha(archive)})`)
const shasums = path.join(cache, `SHASUMS256-${pin.version}.txt`)
if (!fs.existsSync(shasums)) download(pin.shasums, shasums)
const line = fs.readFileSync(shasums, 'utf8').split('\n').find((l) => l.endsWith(`  ${pin.archive}`))
if (!line || line.split(/\s+/)[0] !== pin.sha256) die('nodejs.org SHASUMS256.txt does not list the pinned digest')
if (flag('--verify-signature')) {
  const sig = path.join(cache, `SHASUMS256-${pin.version}.txt.sig`)
  if (!fs.existsSync(sig)) download(pin.signature, sig)
  const gh = fs.mkdtempSync(path.join(os.tmpdir(), 'nxgpg-'))
  fs.chmodSync(gh, 0o700)
  try {
    const env = { ...process.env, GNUPGHOME: gh }
    execFileSync('gpg', ['--batch', '--keyserver', 'hkps://keys.openpgp.org', '--recv-keys', pin.signerFingerprint], { env, stdio: 'ignore' })
    const st = execFileSync('gpg', ['--batch', '--status-fd', '1', '--verify', sig, shasums], { env, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    if (!st.includes(`VALIDSIG ${pin.signerFingerprint}`)) die('the SHASUMS256.txt signature is not by the pinned signer')
  } finally {
    fs.rmSync(gh, { recursive: true, force: true })
  }
  console.log('signature: valid, signer', pin.signerFingerprint)
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nxnode-'))
try {
  execFileSync('tar', ['-xJf', archive, '-C', work])
  const root = path.join(work, pin.archive.replace(/\.tar\.xz$/, ''))
  const node = path.join(root, 'bin', 'node')
  const head = fs.readFileSync(node).subarray(0, 20)
  if (head.subarray(0, 4).toString('latin1') !== '\x7fELF' || head[4] !== 2 || head[5] !== 1 || head.readUInt16LE(18) !== 0x3e) die('bin/node is not an x86-64 Linux ELF executable')
  const ver = execFileSync(node, ['--version'], { env: {} }).toString().trim()
  if (ver !== pin.version) die(`bin/node reports ${ver}, pinned ${pin.version}`)

  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(path.join(out, 'bin'), { recursive: true })
  fs.copyFileSync(node, path.join(out, 'bin', 'node'))
  fs.chmodSync(path.join(out, 'bin', 'node'), 0o755)
  fs.cpSync(path.join(root, 'lib', 'node_modules', 'npm'), path.join(out, 'lib', 'node_modules', 'npm'), { recursive: true })
  for (const f of ['LICENSE']) fs.copyFileSync(path.join(root, f), path.join(out, f))
  // npm and npx are symlinks in the archive; packages do not keep symlinks reliably, so they are small launchers
  const launcher = (cli) => `#!/bin/sh\nd=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$d/node" "$d/../lib/node_modules/npm/bin/${cli}" "$@"\n`
  for (const [n, cli] of [['npm', 'npm-cli.js'], ['npx', 'npx-cli.js']]) {
    fs.writeFileSync(path.join(out, 'bin', n), launcher(cli), { mode: 0o755 })
  }
  fs.writeFileSync(
    path.join(out, 'nexus-node.json'),
    JSON.stringify({ schemaVersion: 1, version: pin.version, arch: pin.arch, nodeSha256: sha(path.join(out, 'bin', 'node')), archiveSha256: pin.sha256, source: pin.url }, null, 2) + '\n',
  )
  console.log(`staged ${pin.name} ${pin.version} (${pin.arch}) -> ${path.relative(process.cwd(), out)}`)
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
