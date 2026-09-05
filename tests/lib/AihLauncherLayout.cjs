'use strict'

/**
 * Launcher-layout abstraction (TASK-0025 Class C) - JS twin of
 * scripts/Platform.ps1 Get-AihLauncherLayout.
 *
 * Distinguishes the layout planes by TREE CONTENT, never by OS alone:
 *   source            - bin/*.cmd launchers plus the bin/linux/*.sh POSIX
 *                       twin templates they mirror (a checkout on any OS).
 *   installed-posix   - extensionless executables in bin/ and no bin/linux
 *                       twin directory (setup.sh installs bin/linux/*.sh as
 *                       canonical extensionless bin/<name> launchers).
 *   installed-windows - bin/*.cmd launchers and no bin/linux twin directory.
 *   unknown           - neither plane detected (empty or broken tree).
 *
 * Test suites assert the contract of the plane they actually run against:
 * the Windows checkout keeps full .cmd -> POSIX twin parity coverage, and an
 * installed POSIX tree is asserted by its OWN extensionless launcher contract
 * instead of demanding source artifacts that must never be copied into an
 * install.
 */

const fs = require('node:fs')
const path = require('node:path')

function detectLauncherLayout(root) {
  const bin = path.join(root, 'bin')
  const posixTwinDir = path.join(bin, 'linux')
  let hasPosixTwins = false
  try {
    hasPosixTwins = fs.readdirSync(posixTwinDir).some((name) => name.endsWith('.sh'))
  } catch (_) {
    hasPosixTwins = false
  }
  let cmdCount = 0
  try {
    cmdCount = fs.readdirSync(bin).filter((name) => name.endsWith('.cmd')).length
  } catch (_) {
    cmdCount = 0
  }
  const hasExtensionless = fs.existsSync(path.join(bin, 'aih'))
  let kind = 'unknown'
  if (hasPosixTwins) kind = 'source'
  else if (hasExtensionless) kind = 'installed-posix'
  else if (cmdCount > 0) kind = 'installed-windows'
  return {
    kind,
    bin,
    posixTwinDir,
    hasPosixTwinTemplates: hasPosixTwins,
    windowsLauncherCount: cmdCount,
    hasExtensionlessLaunchers: hasExtensionless,
  }
}

module.exports = { detectLauncherLayout }
