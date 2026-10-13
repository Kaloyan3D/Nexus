'use strict'

// The source checkout is the only authority allowed to mint this manifest.
// Installed trees consume it without needing Git or the source checkout.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const ENTRIES = Object.freeze([
  'AihController.cjs', 'Muse-Isolation.cjs', 'Muse-ReasoningSignals.cjs',
  'ContextCompilerActiveMuseV2.cjs',
])
const ASSETS = Object.freeze([
  'tokenizers/deepseek-v4-tokenizer.json',
  'tokenizers/deepseek-v4-tokenizer-config.json',
  'tokenizers/deepseek-v4-tokenizer.provenance.json',
])
// R7.1.1: Registry mode definitions are managed runtime assets loaded by
// registry/legacy-import.cjs relative to its own __dirname (fs read, not
// require), so the require-graph walk cannot discover them. Every profile
// whose entry graph reaches the Registry service must pin all three.
const REGISTRY_MODE_ASSETS = Object.freeze([
  'registry/modes/engineering-v1.json',
  'registry/modes/engineering-v2.json',
  'registry/modes/engineering-v3.json',
])
const REGISTRY_RUNTIME_ASSETS = Object.freeze([...ASSETS, ...REGISTRY_MODE_ASSETS])
const MANIFEST = '.muse-preset-closure.json'
const PROFILES = Object.freeze({
  muse: { entries: ENTRIES, assets: REGISTRY_RUNTIME_ASSETS, manifest: MANIFEST },
  controller: { entries: Object.freeze(['AihController.cjs']), assets: REGISTRY_MODE_ASSETS, manifest: '.controller-preset-closure.json' },
  engineering: { entries: Object.freeze(['AihController.cjs', 'Engineering-Isolation.cjs']), assets: REGISTRY_RUNTIME_ASSETS, manifest: '.engineering-preset-closure.json' },
  deepseek: { entries: Object.freeze(['AihController.cjs', 'DeepSeek-Isolation.cjs']), assets: REGISTRY_RUNTIME_ASSETS, manifest: '.deepseek-preset-closure.json' },
})
function profile(options = {}) {
  const name = options.profile || 'muse'
  if (!Object.hasOwn(PROFILES, name)) fail('profile', name)
  return PROFILES[name]
}

function fail(code, detail) { throw new Error(`muse-closure-${code}: ${detail}`) }
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
function within(root, file) {
  const relative = path.relative(root, file)
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}
function safeFile(root, relative) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || relative.split(/[\\/]/).includes('node_modules')) {
    fail('boundary', relative)
  }
  const file = path.resolve(root, relative)
  if (!within(root, file)) fail('boundary', relative)
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail('missing', relative)
  if (!within(fs.realpathSync(root), fs.realpathSync(file))) fail('boundary', relative)
  return file
}
function requires(source, caller) {
  const found = []
  let i = 0
  while (i < source.length) {
    const ch = source[i], next = source[i + 1]
    if (ch === '/' && next === '/') { i = source.indexOf('\n', i + 2); if (i < 0) break; continue }
    if (ch === '/' && next === '*') { const end = source.indexOf('*/', i + 2); if (end < 0) fail('syntax', caller); i = end + 2; continue }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch; i++
      while (i < source.length) { if (source[i] === '\\') { i += 2; continue } if (source[i++] === quote) break }
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i++
      while (i < source.length && /[\w$]/.test(source[i])) i++
      if (source.slice(start, i) !== 'require' || (start > 0 && source[start - 1] === '.')) continue
      let j = i
      while (/\s/.test(source[j] || '')) j++
      if (source[j] !== '(') continue
      j++
      while (/\s/.test(source[j] || '')) j++
      const quote = source[j]
      if (quote !== "'" && quote !== '"') fail('dynamic', caller)
      let value = ''; j++
      while (j < source.length && source[j] !== quote) {
        if (source[j] === '\\') {
          const escaped = source[++j]
          if (escaped !== '\\' && escaped !== '/') fail('dynamic', caller)
          value += escaped
          j++
          continue
        }
        value += source[j++]
      }
      if (source[j++] !== quote) fail('syntax', caller)
      while (/\s/.test(source[j] || '')) j++
      if (source[j] !== ')') fail('dynamic', caller)
      if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value)) fail('boundary', `${caller} -> ${value}`)
      if (value.startsWith('.')) found.push(value)
      i = j + 1
      continue
    }
    i++
  }
  return found
}
function tracked(repo, relative) {
  try { execFileSync('git', ['-C', repo, 'ls-files', '--error-unmatch', '--', 'config/' + relative], { stdio: 'pipe' }) }
  catch { fail('untracked', 'config/' + relative) }
}
function closure(repo, options = {}) {
  const spec = profile(options)
  const root = options.rootIsConfig ? path.resolve(repo) : path.resolve(repo, 'config')
  const seen = new Set()
  function visit(relative) {
    relative = relative.replace(/\\/g, '/')
    const file = safeFile(root, relative)
    relative = path.relative(root, file).split(path.sep).join('/')
    if (options.requireTracked !== false) tracked(repo, relative)
    if (seen.has(relative)) return
    seen.add(relative)
    if (!relative.endsWith('.cjs')) return
    for (const request of requires(fs.readFileSync(file, 'utf8'), relative)) {
      const resolved = path.resolve(path.dirname(file), request.replace(/\\/g, '/'))
      if (!within(root, resolved)) fail('boundary', `${relative} -> ${request}`)
      visit(path.relative(root, resolved))
    }
  }
  for (const entry of options.entries || spec.entries) visit(entry)
  for (const asset of options.assets || spec.assets) visit(asset)
  return [...seen].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
}
function prepare(source, install, options = {}) {
  const spec = profile(options)
  const files = closure(source, options)
  const rows = files.map(name => ({ name, sha256: sha(safeFile(path.join(source, 'config'), name)) }))
  const destination = path.join(install, 'config')
  fs.mkdirSync(destination, { recursive: true })
  for (const row of rows) {
    const target = path.join(destination, row.name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(source, 'config', row.name), target)
  }
  fs.writeFileSync(path.join(destination, spec.manifest), JSON.stringify({ version: 1, entrypoints: spec.entries, files: rows }, null, 2) + '\n')
  return rows
}
function installed(install, options = {}) {
  const spec = profile(options)
  const config = path.join(install, 'config')
  const manifest = JSON.parse(fs.readFileSync(path.join(config, spec.manifest), 'utf8'))
  if (manifest.version !== 1 || JSON.stringify(manifest.entrypoints) !== JSON.stringify(spec.entries)) fail('manifest', 'entrypoints/version changed')
  const names = closure(install, { ...options, requireTracked: false })
  if (JSON.stringify(manifest.files.map(row => row.name)) !== JSON.stringify(names)) fail('manifest', 'dependency graph differs from source manifest')
  for (const row of manifest.files) if (sha(safeFile(config, row.name)) !== row.sha256) fail('hash', row.name)
  return manifest.files
}
function copy(install, preset, options = {}) {
  const rows = installed(install, options)
  for (const row of rows) {
    const target = path.join(preset, row.name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(install, 'config', row.name), target)
  }
  validate(install, preset, options)
  return rows
}
function validate(install, preset, options = {}) {
  const spec = profile(options)
  const rows = installed(install, options)
  for (const row of rows) if (sha(safeFile(preset, row.name)) !== row.sha256) fail('installed', row.name)
  const actual = closure(preset, { ...options, requireTracked: false, rootIsConfig: true })
  if (JSON.stringify(actual) !== JSON.stringify(rows.map(row => row.name))) fail('installed', 'dependency graph differs from manifest')
  for (const entry of spec.entries) require(path.join(preset, entry))
  return rows
}
function main() {
  const [action, a, b, profileName] = process.argv.slice(2)
  const options = { profile: profileName || 'muse' }
  let rows
  if (action === 'plan') rows = closure(path.resolve(a), { profile: b || 'muse' }).map(name => ({ name }))
  else if (action === 'prepare') rows = prepare(path.resolve(a), path.resolve(b), options)
  else if (action === 'copy') rows = copy(path.resolve(a), path.resolve(b), options)
  else if (action === 'validate') rows = validate(path.resolve(a), path.resolve(b), options)
  else fail('usage', 'expected plan|prepare|copy|validate')
  process.stdout.write(JSON.stringify({ dependencyClosure: rows.map(row => row.name) }) + '\n')
}
if (require.main === module) { try { main() } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1 } }
module.exports = { closure, prepare, copy, validate, requires }
