'use strict'

/**
 * Registry Core public surface (R1).
 *
 * Stable, runtime-independent entry point for the Nexus-owned Model Registry.
 * Re-exports schemas, the pure compiler, and the read-only legacy import
 * helper. Importing this module must never require DSH, PowerShell, network
 * access, or credentials.
 */

const schemas = require('./schemas.cjs')
const resolver = require('./resolver.cjs')
const legacyImport = require('./legacy-import.cjs')

module.exports = {
  schemas,
  resolver,
  legacyImport,
}
