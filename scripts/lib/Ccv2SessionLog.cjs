'use strict';
/**
 * Ccv2SessionLog.cjs - read a persisted DSH session log as the canonical
 * contiguous event list, through the pinned DSH storage codec itself
 * (@deepseek-ai/dsh-session decodeStorageRecord expands packed chunk rows
 * back into their exact assistant/chunk events). Read-only: the session
 * file is never written. Used by CCv2 replay/acceptance tooling; the live
 * producer consumes the in-process session object instead.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');

function defaultInstallRoot() {
  if (typeof process.env.NEXUS_INSTALL_ROOT === 'string' && process.env.NEXUS_INSTALL_ROOT !== '') {
    return path.resolve(process.env.NEXUS_INSTALL_ROOT);
  }
  return path.join(os.homedir(), '.local', 'share', 'nexus');
}

function loadDshSessionModule(installRoot) {
  const root = installRoot === undefined || installRoot === null ? defaultInstallRoot() : path.resolve(installRoot);
  const requireFromApp = createRequire(path.join(root, 'app', 'package.json'));
  const mod = requireFromApp('@deepseek-ai/dsh-session');
  if (!mod || typeof mod.decodeStorageRecord !== 'function') throw new Error('dsh-session decodeStorageRecord is unavailable');
  return mod;
}

function sessionFilePath(dataRoot, workspaceKey, sessionId) {
  return path.join(dataRoot, 'sessions', workspaceKey, sessionId, 'session.jsonl.zstd');
}

/**
 * Returns { header, events } with events contiguous from seq 0 (verified).
 */
function readSessionLog(filePath, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const raw = fs.readFileSync(filePath);
  const text = filePath.endsWith('.zstd') ? zlib.zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8');
  const dsh = loadDshSessionModule(opts.installRoot);
  const lines = text.split('\n').filter((line) => line !== '');
  if (lines.length === 0) throw new Error('session log is empty');
  const header = JSON.parse(lines[0]);
  if (!header || header.type !== 'session' || typeof header.id !== 'string') throw new Error('session log header is missing');
  const events = [];
  for (let index = 1; index < lines.length; index += 1) {
    for (const event of dsh.decodeStorageRecord(JSON.parse(lines[index]))) events.push(event);
  }
  for (let index = 0; index < events.length; index += 1) {
    if (!events[index] || events[index].seq !== index) throw new Error('session log is not contiguous at index ' + index);
  }
  return { header, events, sourceBytes: raw.length, decodedBytes: Buffer.byteLength(text, 'utf8') };
}

module.exports = { defaultInstallRoot, loadDshSessionModule, sessionFilePath, readSessionLog };
