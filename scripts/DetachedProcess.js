'use strict'

// Linux launcher for processes that must outlive the invoking PowerShell host.
// Argument transport is JSON/base64, so no shell parses or rejoins argv.
const fs = require('node:fs')
const { spawn } = require('node:child_process')

const request = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'))
const opened = []
try {
  const stdio = ['ignore', 'ignore', 'ignore']
  for (const [index, file] of [[1, request.stdout], [2, request.stderr]]) {
    if (file) {
      const fd = fs.openSync(file, 'w', 0o600)
      opened.push(fd)
      stdio[index] = fd
    }
  }
  const child = spawn(request.file, request.args, {
    cwd: request.cwd || undefined,
    detached: true,
    stdio,
    windowsHide: true,
  })
  child.once('error', (error) => {
    console.error(error.message)
    process.exitCode = 1
  })
  child.once('spawn', () => {
    if (request.wait) {
      child.once('exit', (code, signal) => {
        process.stdout.write(JSON.stringify({ pid: child.pid, exitCode: code === null ? 128 + (signal === 'SIGTERM' ? 15 : 9) : code }) + '\n')
      })
    } else {
      process.stdout.write(String(child.pid) + '\n')
      child.unref()
    }
  })
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  for (const fd of opened) fs.closeSync(fd)
}
