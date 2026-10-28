#!/usr/bin/env node
// Write src-tauri/resources/THIRD-PARTY-NOTICES.md: every third-party component that is REDISTRIBUTED in the
// package, with its version and license identifier, plus the full Node.js license text (which carries Node's own
// bundled third-party notices) and a pointer to npm's own license file inside the bundled tree.
//   - Rust crates: the normal (non-dev, non-build-only-for-host) dependency closure of the shipped programs
//   - JavaScript: the production dependencies of the Desktop front end
// Licenses are listed by SPDX identifier from each package's own metadata; the license TEXTS ship inside the
// crate/package sources and are available from the listed registries.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
const desk = path.resolve(here, '..')
const repo = path.resolve(desk, '..', '..')
const pin = JSON.parse(fs.readFileSync(path.join(here, 'node-runtime.json'), 'utf8'))

function crates(manifest, roots) {
  const md = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--offline', '--filter-platform', 'x86_64-unknown-linux-gnu', '--manifest-path', manifest], { maxBuffer: 1 << 28 }).toString())
  const pkgs = new Map(md.packages.map((p) => [p.id, p]))
  const nodes = new Map(md.resolve.nodes.map((n) => [n.id, n]))
  const start = md.packages.filter((p) => roots.includes(p.name)).map((p) => p.id)
  const seen = new Set()
  const walk = (id) => {
    if (seen.has(id)) return
    seen.add(id)
    for (const d of nodes.get(id)?.deps ?? []) if (d.dep_kinds.some((k) => k.kind === null)) walk(d.pkg)
  }
  start.forEach(walk)
  return [...seen].map((id) => pkgs.get(id)).filter((p) => !p.source?.startsWith('path+') && p.source)
}
const rust = new Map()
for (const [m, roots] of [
  [path.join(repo, 'native', 'Cargo.toml'), ['nexusd', 'nexus-broker', 'nexus-confine', 'nexus-egress', 'nexus-approver', 'nexus-daemon', 'nexus-cli']],
  [path.join(desk, 'src-tauri', 'Cargo.toml'), ['nexus-desktop']],
]) {
  for (const p of crates(m, roots)) rust.set(`${p.name}@${p.version}`, p.license ?? 'UNKNOWN')
}
const js = new Map()
const pkgJson = JSON.parse(fs.readFileSync(path.join(desk, 'package.json'), 'utf8'))
const walkJs = (name) => {
  const f = path.join(desk, 'node_modules', name, 'package.json')
  if (!fs.existsSync(f)) return
  const j = JSON.parse(fs.readFileSync(f, 'utf8'))
  if (js.has(`${j.name}@${j.version}`)) return
  js.set(`${j.name}@${j.version}`, typeof j.license === 'string' ? j.license : (j.license?.type ?? 'UNKNOWN'))
  for (const d of Object.keys(j.dependencies ?? {})) walkJs(d)
}
Object.keys(pkgJson.dependencies ?? {}).forEach(walkJs)

const nodeLicense = fs.readFileSync(path.join(desk, 'src-tauri', 'resources', 'node', 'LICENSE'), 'utf8')
const table = (m) => [...m.entries()].sort().map(([k, v]) => `| ${k} | ${v} |`).join('\n')
const md = `# Third-party notices — Nexus

Nexus is distributed together with the components below. Each keeps its own license.

## Node.js ${pin.version} (${pin.line}), bundled privately at \`/usr/lib/Nexus/node\`

Source: ${pin.url}
SHA-256 of the archive: \`${pin.sha256}\` (verified against nodejs.org SHASUMS256.txt, signed by ${pin.signerFingerprint}).
It is used only by Nexus (it is not placed on any PATH and the system Node.js is not touched). npm is included
unmodified under \`/usr/lib/Nexus/node/lib/node_modules/npm\` with its own \`LICENSE\` (Artistic-2.0).

<details><summary>Node.js LICENSE (includes the notices of Node's own bundled third-party software)</summary>

\`\`\`
${nodeLicense}
\`\`\`
</details>

## Rust crates in the Nexus programs (${rust.size})

| Crate | License |
|---|---|
${table(rust)}

## JavaScript packages in the Desktop front end (${js.size})

| Package | License |
|---|---|
${table(js)}

## System libraries

The Desktop uses the system's GTK 3, WebKitGTK 4.1 and glibc through the package manager (declared dependencies);
they are not redistributed in this package.
`
fs.writeFileSync(path.join(desk, 'src-tauri', 'resources', 'THIRD-PARTY-NOTICES.md'), md)
console.log(`notices: ${rust.size} crates, ${js.size} JS packages`)
