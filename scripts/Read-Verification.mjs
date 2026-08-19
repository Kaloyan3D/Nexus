import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [file, installRoot] = process.argv.slice(2)
if (!file || !installRoot) {
  throw new Error('usage: Read-Verification.mjs <verification.yml> <install-root>')
}

const require = createRequire(pathToFileURL(join(installRoot, 'app', 'package.json')))
const yaml = require('js-yaml')
const document = yaml.load(readFileSync(file, 'utf8'))

if (!document || typeof document !== 'object' || Array.isArray(document)) {
  throw new Error('verification.yml must contain a mapping')
}
if (document.version !== 1) {
  throw new Error('verification.yml version must be 1')
}
const mode = document.mode ?? 'replace'
if (mode !== 'replace' && mode !== 'append') {
  throw new Error('verification.yml mode must be replace or append')
}
if (!Array.isArray(document.commands) || document.commands.length === 0) {
  throw new Error('verification.yml commands must be a non-empty list')
}

const kinds = new Set(['build', 'test', 'typecheck', 'lint', 'integration', 'verify', 'other'])
const names = new Set()
const commands = document.commands.map((entry, index) => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`verification.yml commands[${index}] must be a mapping`)
  }
  const name = entry.name
  const command = entry.command
  const kind = entry.kind ?? 'other'
  const workingDirectory = entry.workingDirectory ?? '.'
  const required = entry.required ?? true
  const timeoutSeconds = entry.timeoutSeconds ?? 1200
  if (typeof name !== 'string' || !name.trim()) throw new Error(`verification.yml commands[${index}].name is required`)
  if (names.has(name)) throw new Error(`verification.yml command name is duplicated: ${name}`)
  names.add(name)
  if (typeof command !== 'string' || !command.trim()) throw new Error(`verification.yml commands[${index}].command is required`)
  if (!kinds.has(kind)) throw new Error(`verification.yml commands[${index}].kind is invalid`)
  if (typeof workingDirectory !== 'string' || !workingDirectory.trim()) throw new Error(`verification.yml commands[${index}].workingDirectory is invalid`)
  const normalized = workingDirectory.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`verification.yml commands[${index}].workingDirectory must stay inside the workspace`)
  }
  if (typeof required !== 'boolean') throw new Error(`verification.yml commands[${index}].required must be boolean`)
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86400) {
    throw new Error(`verification.yml commands[${index}].timeoutSeconds must be an integer from 1 to 86400`)
  }
  return { name, command, kind, workingDirectory, required, timeoutSeconds }
})

process.stdout.write(JSON.stringify({ version: 1, mode, commands }))
