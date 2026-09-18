'use strict';
/**
 * Shared production-path harness: drives the REAL AihController pre-step
 * orchestration (config/AihController.cjs apply()) against a REAL task
 * ledger workspace plus REAL DSH Session objects.
 *
 * The fake ctx implements exactly the surface production uses: shellEnv,
 * on(session/event, agent/pre-step, agent/disposed), get(sessions |
 * systemPrompt). DSH module resolution is installRoot-anchored, so the
 * REAL pinned factories load (createUserMessage, Session.fromRestore).
 *
 * Env contract (set by the caller BEFORE requiring the bridge):
 *   DSH_HOME -> temp data root (bindings, logs, tmp)
 *   AIH_INSTALL_ROOT -> repo checkout (config + scripts identity)
 *   AIH_TOOLCHAIN_ROOT -> repo checkout (pwsh/CLI spawning)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');

function makeDataRoot() {
  // Shape the fixture like a real install: <fakeInstall>/data is DSH_HOME
  // so the bridge resolves installRoot = dirname(DSH_HOME), with scripts
  // and config linked to the repo checkout under test.
  const fakeInstall = fs.mkdtempSync(path.join(os.tmpdir(), 'prodtest-install-'));
  const dataRoot = path.join(fakeInstall, 'data');
  fs.mkdirSync(path.join(dataRoot, 'routing'), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'routing', 'session-bindings.json'), JSON.stringify({ schemaVersion: 1, bindings: {} }));
  fs.symlinkSync(path.join(repoRoot, 'scripts'), path.join(fakeInstall, 'scripts'), 'dir');
  fs.symlinkSync(path.join(repoRoot, 'config'), path.join(fakeInstall, 'config'), 'dir');
  // Mirror the production host tree: the bridge resolves pinned DSH modules
  // (factories, Session.fromRestore) through <installRoot>/app. Without
  // this link the refresh/durable-proof paths fail safe to null (KEEP).
  const hostApp = resolveHostApp();
  if (hostApp) {
    try { fs.symlinkSync(hostApp, path.join(fakeInstall, 'app'), 'dir'); } catch {}
  }
  return dataRoot;
}

function resolveHostApp() {
  const candidates = [];
  if (process.env.AIH_HOST_APP) candidates.push(process.env.AIH_HOST_APP);
  if (process.env.DSH_HOME) candidates.push(path.join(path.dirname(path.resolve(process.env.DSH_HOME)), '..'));
  candidates.push('/home/kaloyan/.local/share/nexus/app');
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    } catch {}
  }
  return null;
}

function pwshFile(script, args, payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prodtest-cli-'));
  const payloadFile = path.join(dir, 'p.json');
  fs.writeFileSync(payloadFile, JSON.stringify(payload));
  const out = execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script].concat(args).concat(['-PayloadFile', payloadFile]), { encoding: 'utf8', timeout: 120000 });
  const text = out.trim();
  return text === '' ? null : JSON.parse(text);
}

function makeCtx({ flushImpl, systemPromptImpl } = {}) {
  const handlers = { 'session/event': [], 'agent/pre-step': [], 'agent/disposed': [] };
  const sessionsService = {
    flushCalls: [],
    async flush(session) {
      sessionsService.flushCalls.push(session && session.id);
      if (typeof flushImpl === 'function') return flushImpl(session);
      return true;
    },
  };
  const ctx = {
    shellEnv: { register() {} },
    on(name, fn) { if (handlers[name]) handlers[name].push(fn); return () => {}; },
    get(name) {
      if (name === 'sessions') return sessionsService;
      if (name === 'systemPrompt') return systemPromptImpl || null;
      return null;
    },
    _handlers: handlers,
    _sessionsService: sessionsService,
  };
  return ctx;
}

function loadBridge() {
  const modPath = path.join(repoRoot, 'config', 'AihController.cjs');
  delete require.cache[modPath];
  return require(modPath);
}

function loadDshSession() {
  const cand = '/home/kaloyan/.local/share/nexus/app/node_modules/@deepseek-ai/dsh-session/lib/index.js';
  return require(cand);
}

// Production-faithful DSH message builders: every message carries a stable
// id exactly like the loop factories (createUserMessage) and the bridge
// controller notices (createControllerMessage) do. Fixtures WITHOUT ids do
// not resemble production logs and fail resume validation by design.
function identifiedUserMessage(text, source) {
  return { id: 'msg-' + Math.random().toString(16).slice(2) + Date.now().toString(16), role: 'user', content: [{ type: 'text', text }], source: source || { kind: 'user' } };
}
function newMessageId() {
  return 'msg-' + Math.random().toString(16).slice(2) + Date.now().toString(16);
}
function identifiedToolResult(callId, text, turn, step) {
  return { turn, step, message: { id: newMessageId(), role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] } };
}
function identifiedAssistantMessage(text, turn, step, contentOrNull) {
  const content = contentOrNull || [{ type: 'text', text }];
  const modelSource = { kind: 'model', provider: 'fixture-provider', model: 'fixture-model' };
  return { turn, step, message: { id: newMessageId(), role: 'assistant', content: content, source: modelSource }, source: modelSource };
}
function seedBinding(dataRoot, sessionId, binding) {
  const p = path.join(dataRoot, 'routing', 'session-bindings.json');
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  doc.bindings[sessionId] = binding;
  fs.writeFileSync(p, JSON.stringify(doc));
}

module.exports = { repoRoot, makeDataRoot, pwshFile, makeCtx, loadBridge, loadDshSession, seedBinding, identifiedUserMessage, identifiedAssistantMessage, identifiedToolResult, newMessageId };
