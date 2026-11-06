'use strict'

// Build-NexusHomePatch.cjs — composes the Nexus product layer for DSH 0.2.x.
//
//   node scripts/Build-NexusHomePatch.cjs <InstallRoot> [--check]
//
// DSH 0.2.x no longer scans `$DSH_HOME/.agent-presets/<name>/agent.cordis.yml`
// and no longer ships `dsh/config/agent-presets`. Agent presets are ordinary
// plugin rows (`@deepseek-ai/dsh-agent-preset`) in the composed profile tree,
// and `$DSH_HOME/cordis.patch.yml` is the supported home-level patch layer
// (applied after the profile layer, before `--patch` overlays).
//
// This script regenerates that home patch (data/cordis.patch.yml) from:
//   1. config/home.cordis.patch.yml     static Nexus plugin rows
//   2. data/nexus-settings.yaml         Nexus-owned settings document
//                                        (DSH 0.2.x imports and RENAMES any
//                                        `$DSH_HOME/settings.yaml`, so the
//                                        Nexus document must not use that name)
//   3. the installed Code-mode equivalent: `@deepseek-ai/dsh-web-app`
//      `presets/standard.patch.yml`, transformed per Nexus plane with strict
//      structural checks (a changed upstream shape fails closed, never a
//      silent partial preset).
//
// Generated content:
//   - agent-preset-registry default (from nexus-settings `agent-presets.default`)
//   - the shipped stock presets (standard/ptc/minimal/cordis) DISABLED: only the
//     Nexus controller planes may be selected, so no session can run outside the
//     deterministic controller
//   - agent-default-model and llm-pi-ai provider routes (from nexus-settings)
//   - three presets: aih-engineering, aih-deepseek, aih-muse
//
// The output is deterministic; running it twice yields identical bytes.

const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const PLANES = Object.freeze({
  'aih-engineering': {
    metadata: 'preset.yml',
    personaEnv: 'AIH_PERSONA',
    persona: 'You are the DeepSeek implementation agent. Complete the supplied bounded task using repository-local instructions and relevant context. Use targeted verification and return structured evidence. The deterministic controller owns routing, retries, budgets, escalation, completion, and automatic Visual Review. Never discover or invoke Visual Review through the skill catalog. If blocked, return one scoped escalation with a stable failure signature.',
    delegation: 'nexus',
    codexSubagent: true,
    tail: [['aih-engineering-isolation', 'aih-engineering/Engineering-Isolation.cjs'], ['aih-controller', 'aih-engineering/AihController.cjs']],
  },
  'aih-deepseek': {
    metadata: 'preset-deepseek.yml',
    personaEnv: 'AIH_PERSONA_DEEPSEEK',
    persona: 'You are the DeepSeek implementation agent. Complete the supplied bounded task using repository-local instructions and relevant context. Use targeted verification and return structured evidence. The deterministic controller owns routing, retries, budgets, escalation, completion, and automatic Visual Review. Never discover or invoke Visual Review through the skill catalog. Codex is unavailable in this preset.',
    delegation: 'nexus',
    codexSubagent: false,
    tail: [['aih-deepseek-isolation', 'aih-deepseek/DeepSeek-Isolation.cjs'], ['aih-controller', 'aih-deepseek/AihController.cjs']],
  },
  'aih-muse': {
    metadata: 'preset-muse.yml',
    personaEnv: 'AIH_PERSONA_MUSE',
    persona: 'You are the Muse engineering agent. Complete the supplied bounded task. Inspect the repository evidence first, follow repository-local instructions, use the available tools as required, and verify with a targeted check before reporting. Return concrete evidence for what you changed and verified. The deterministic controller owns routing, attempts, verification results, and task completion; you never declare completion or re-route yourself. You are a single engineering agent. There are no subagents, reviewers, or fallback engineers on this plane. Report meaningful trajectory phase changes and established findings through the muse_update_reasoning_state tool; you never choose reasoning effort yourself.',
    delegation: 'none',
    codexSubagent: false,
    tail: [['aih-muse-isolation', 'aih-muse/Muse-Isolation.cjs'], ['aih-muse-reasoning-signals', 'aih-muse/Muse-ReasoningSignals.cjs'], ['aih-controller', 'aih-muse/AihController.cjs']],
  },
})
const STOCK_PRESET_ROWS = Object.freeze(['preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis'])
const BEGIN = '# ---- BEGIN NEXUS GENERATED (scripts/Build-NexusHomePatch.cjs; do not edit) ----'
const END = '# ---- END NEXUS GENERATED ----'

function fail(code, detail) { throw new Error(`nexus-home-patch-${code}: ${detail}`) }

function readMetadata(file) {
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^(name|description|order):\s*(.*)$/.exec(line)
    if (match) out[match[1]] = match[2].trim()
  }
  if (!out.name || !out.description || out.order === undefined || !/^\d+$/.test(out.order)) fail('metadata', file)
  return out
}

/** Split the standard preset's `plugins:` list into top-level item text blocks. */
function standardPluginItems(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((line) => line === '        plugins:')
  if (start < 0) fail('standard-shape', 'plugins list not found')
  const items = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^ {10}- id: /.test(line)) { items.push({ id: line.slice(15).trim(), lines: [line] }); continue }
    if (line.trim() !== '' && !/^ {10}/.test(line) && !/^\s*#/.test(line)) fail('standard-shape', 'unexpected line after plugins: ' + line)
    if (items.length === 0) { if (line.trim() === '' || /^\s*#/.test(line)) continue; fail('standard-shape', 'text before first plugin item') }
    items[items.length - 1].lines.push(line)
  }
  if (items.length === 0) fail('standard-shape', 'empty plugins list')
  for (const item of items) while (item.lines.length && item.lines[item.lines.length - 1].trim() === '') item.lines.pop()
  return items
}

function dedent(item, by) {
  return item.lines.map((line) => (line.startsWith(' '.repeat(by)) ? line.slice(by) : line))
}

function indentBlock(text, spaces) {
  const pad = ' '.repeat(spaces)
  return text.replace(/\r\n/g, '\n').split('\n').map((line) => (line === '' ? line : pad + line)).join('\n')
}

function quote(text) { return "'" + String(text).replace(/'/g, "''") + "'" }

function personaItem(plane) {
  return [
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    `    prefix: !!js process.env.${plane.personaEnv} ?? ${quote(plane.persona)}`,
  ]
}

/**
 * The Nexus delegation group, read from config/delegation-block.yml (the single
 * source). The disabled codex row is removed structurally for planes without it.
 */
function delegationItem(plane, configDir) {
  const text = fs.readFileSync(path.join(configDir, 'delegation-block.yml'), 'utf8').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line === '- id: delegation')
  if (start < 0) fail('delegation-shape', 'config/delegation-block.yml has no top-level delegation item')
  const body = lines.slice(start).filter((line) => !/^\s*#/.test(line))
  while (body.length && body[body.length - 1].trim() === '') body.pop()
  const out = []
  let skipping = false
  for (const line of body) {
    if (/^ {4}- id: /.test(line)) skipping = !plane.codexSubagent && line === '    - id: tool-subagent-codex'
    if (skipping) continue
    out.push(line)
  }
  const joined = out.filter((line, index) => !(line.trim() === '' && (out[index + 1] === undefined || out[index + 1].trim() === '')))
  if (plane.codexSubagent && !joined.includes('    - id: tool-subagent-codex')) fail('delegation-shape', 'the engineering plane needs the disabled codex row')
  if (!plane.codexSubagent && joined.includes('    - id: tool-subagent-codex')) fail('delegation-shape', 'the codex row must be absent outside the engineering plane')
  return joined
}

function presetRow(presetId, plane, items, metadata, closureRoot, configDir) {
  const out = []
  for (const item of items) {
    if (item.id === 'persona') out.push(...personaItem(plane))
    else if (item.id === 'delegation') { if (plane.delegation === 'nexus') out.push(...delegationItem(plane, configDir)) }
    else out.push(...dedent(item, 10))
  }
  // Relative plugin names do not start inside an in-memory preset tree (DSH 0.2.x
  // registry mounts have no file base and report "never started"), so closure
  // modules are addressed by absolute file URL.
  for (const [id, relative] of plane.tail) out.push(`- id: ${id}`, `  name: ${quote(pathToFileURL(path.join(closureRoot, relative)).href)}`)
  const body = out.map((line) => (line === '' ? line : '          ' + line)).join('\n')
  return [
    `    - id: preset-${presetId}`,
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    `        id: ${presetId}`,
    `        name: ${quote(metadata.name)}`,
    `        description: ${quote(metadata.description)}`,
    `        order: ${metadata.order}`,
    '        plugins:',
    body,
  ].join('\n')
}

function build(installRoot, options = {}) {
  const root = path.resolve(installRoot)
  const requireFromApp = createRequire(path.join(root, 'app', 'package.json'))
  const yaml = requireFromApp('js-yaml')
  const configDir = path.join(root, 'config')
  const staticPatch = fs.readFileSync(path.join(configDir, 'home.cordis.patch.yml'), 'utf8').replace(/\r\n/g, '\n').trimEnd()

  const settingsPath = fs.existsSync(path.join(root, 'data', 'nexus-settings.yaml'))
    ? path.join(root, 'data', 'nexus-settings.yaml')
    : path.join(configDir, 'settings.yaml')
  const settings = yaml.load(fs.readFileSync(settingsPath, 'utf8')) || {}
  const defaultPreset = settings['agent-presets'] && settings['agent-presets'].default
  if (!Object.hasOwn(PLANES, defaultPreset)) fail('default-preset', `agent-presets.default must be one of ${Object.keys(PLANES).join(', ')} (got ${defaultPreset})`)
  const defaultModel = settings['agent-default-model']
  if (!defaultModel || !defaultModel.provider || !defaultModel.model) fail('default-model', 'agent-default-model needs provider and model')
  const piAi = settings['llm-pi-ai']
  if (!piAi || typeof piAi.providers !== 'object') fail('providers', 'llm-pi-ai.providers is required')

  const standardFile = path.join(path.dirname(requireFromApp.resolve('@deepseek-ai/dsh-web-app/package.json')), 'presets', 'standard.patch.yml')
  if (!fs.existsSync(standardFile)) fail('standard-preset-missing', standardFile)
  const items = standardPluginItems(fs.readFileSync(standardFile, 'utf8'))
  if (items.filter((item) => item.id === 'persona').length !== 1) fail('standard-shape', 'expected exactly one persona item')
  if (items.filter((item) => item.id === 'delegation').length !== 1) fail('standard-shape', 'expected exactly one delegation group')

  const rows = []
  rows.push(BEGIN)
  rows.push('- id: agent-preset-registry', '  config:', `    default: ${defaultPreset}`)
  for (const id of STOCK_PRESET_ROWS) rows.push(`- id: ${id}`, '  disabled: true')
  rows.push('- id: agent-default-model', '  config:', indentBlock(yaml.dump(defaultModel, { lineWidth: -1, noRefs: true }).trimEnd(), 4))
  rows.push('- id: llm-pi-ai', '  config:', indentBlock(yaml.dump({ providers: piAi.providers }, { lineWidth: -1, noRefs: true }).trimEnd(), 4))
  rows.push('- insert:')
  for (const presetId of Object.keys(PLANES)) {
    rows.push(presetRow(presetId, PLANES[presetId], items, readMetadata(path.join(configDir, PLANES[presetId].metadata)), path.join(root, 'data', '.agent-presets'), configDir))
  }
  rows.push(END)
  const output = staticPatch + '\n\n' + rows.join('\n') + '\n'
  // Round-trip with the real YAML parser (tag-tolerant) as a syntax gate.
  const jsType = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (data) => String(data) })
  yaml.load(output, { schema: yaml.DEFAULT_SCHEMA.extend([jsType]) })
  if (!options.check) {
    const target = path.join(root, 'data', 'cordis.patch.yml')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const temporary = target + '.tmp-' + process.pid
    fs.writeFileSync(temporary, output, 'utf8')
    fs.renameSync(temporary, target)
  }
  return { output, planes: Object.keys(PLANES), defaultPreset, settingsPath }
}

module.exports = { build, standardPluginItems, PLANES, STOCK_PRESET_ROWS, BEGIN, END }

if (require.main === module) {
  try {
    const installRoot = process.argv[2]
    if (!installRoot) fail('usage', 'InstallRoot argument is required')
    const result = build(installRoot, { check: process.argv.includes('--check') })
    console.log(`Nexus home patch ${process.argv.includes('--check') ? 'verified' : 'written'}: planes=${result.planes.join(',')} default=${result.defaultPreset}`)
  } catch (error) {
    console.error(String(error && error.message ? error.message : error))
    process.exit(1)
  }
}
