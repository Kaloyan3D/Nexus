#!/usr/bin/env node
// Stage the non-binary runtime files into src-tauri/resources/repo/ with their directory structure:
//   config/registry/**            (the Registry bridge and its mode definitions)
//   scripts/<named scripts>       (provider connection and verification, run by the runtime with the private Node)
// and the notices. Missing sources abort the build.
import fs from 'node:fs'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
const repo = path.resolve(here, '..', '..', '..')
const out = path.resolve(here, '..', 'src-tauri', 'resources', 'repo')
const SCRIPTS = ['Setup-NativeOpenCodeGo.cjs', 'Verify-NativeOpenCodeGoRoute.cjs']
fs.rmSync(out, { recursive: true, force: true })
fs.cpSync(path.join(repo, 'config', 'registry'), path.join(out, 'config', 'registry'), { recursive: true })
fs.mkdirSync(path.join(out, 'scripts'), { recursive: true })
for (const s of SCRIPTS) {
  const src = path.join(repo, 'scripts', s)
  if (!fs.existsSync(src)) {
    console.error(`stage-resources: missing ${src}`)
    process.exit(1)
  }
  fs.copyFileSync(src, path.join(out, 'scripts', s))
}
console.log(`staged repo files -> ${path.relative(process.cwd(), out)}`)
